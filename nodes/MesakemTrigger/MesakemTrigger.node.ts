import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { idSegment, isObject, str } from '../shared/config';
import {
	EVENT_OPTIONS,
	EVENT_TYPES,
	SOURCE_OPTIONS,
	TEST_EVENT,
	eventBase,
	hydrateEvent,
} from '../shared/events';
import type { OperationInfo } from '../shared/errors';
import { isWebhookSecret, verifyStandardWebhook, webhookHeaders } from '../shared/signature';
import { mesakemJson, mesakemRequest } from '../shared/transport';

/**
 * Instant trigger. With "Automatic" registration, activating the workflow creates ONE Mesakem
 * webhook endpoint for this workflow's address (POST /v1/webhooks) and deactivating deletes it.
 * Mesakem pushes each event; nothing here ever polls. Every delivery is checked against the
 * Standard Webhooks signature before anything else happens.
 */

const WEBHOOK_OPERATION: OperationInfo = { label: 'Register the Mesakem webhook', scope: 'webhooks:write', webhook: true };

interface StoredEndpoint extends IDataObject {
	id: string;
	secret: string;
	events: string[];
}

/** Workflow static data: one endpoint per webhook address (test and production URLs differ). */
function endpoints(staticData: IDataObject): Record<string, StoredEndpoint> {
	if (!isObject(staticData.endpoints)) staticData.endpoints = {};
	return staticData.endpoints as Record<string, StoredEndpoint>;
}

function selectedEvents(context: IHookFunctions | IWebhookFunctions): string[] {
	const raw = context.getNodeParameter('events', []) as unknown;
	const list = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
	return EVENT_TYPES.filter((type) => list.includes(type));
}

function sameEvents(a: unknown, b: string[]): boolean {
	if (!Array.isArray(a)) return false;
	const left = [...new Set(a.map(String))].sort();
	const right = [...new Set(b)].sort();
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isManual(context: IHookFunctions | IWebhookFunctions): boolean {
	return context.getNodeParameter('registration', 'automatic') === 'manual';
}

function rawBodyOf(context: IWebhookFunctions): string {
	const request = context.getRequestObject() as unknown as { rawBody?: unknown };
	const raw = request.rawBody;
	if (Buffer.isBuffer(raw)) return raw.toString('utf8');
	if (typeof raw === 'string') return raw;
	// Mesakem sends compact JSON.stringify output, so re-serialising the parsed body gives the same bytes.
	return JSON.stringify(context.getBodyData());
}

function reject(context: IWebhookFunctions, status: number, error: string): IWebhookResponseData {
	const response = context.getResponseObject();
	response.status(status).json({ error });
	return { noWebhookResponse: true };
}

export class MesakemTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Mesakem Trigger',
		name: 'mesakemTrigger',
		icon: { light: 'file:../../icons/mesakem.svg', dark: 'file:../../icons/mesakem.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{($parameter["events"] || []).join(", ")}}',
		description: 'Starts the workflow when Mesakem has a new summary, transcript, meeting update or task',
		defaults: { name: 'Mesakem Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'mesakemApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName:
					'Mesakem delivers only to public https addresses (port 443 or 8443), so this n8n instance must be reachable from the internet.',
				name: 'publicNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Registration',
				name: 'registration',
				type: 'options',
				noDataExpression: true,
				default: 'automatic',
				options: [
					{
						name: 'Automatic',
						value: 'automatic',
						description:
							'Activating the workflow creates the Mesakem webhook and deactivating removes it. Needs a key with the Manage webhooks permission (paid plan).',
					},
					{
						name: 'Manual',
						value: 'manual',
						description:
							'You add this workflow\'s production URL as a webhook in Mesakem → Settings → API & webhooks and paste its signing secret here. Works on the Free plan.',
					},
				],
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['summary.ready'],
				options: EVENT_OPTIONS,
				description:
					'The events that start this workflow. With Manual registration, choose the same events in Mesakem Settings; other events are ignored here.',
			},
			{
				displayName: 'Signing Secret',
				name: 'signingSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				placeholder: 'whsec_…',
				description: 'Shown once when you create the webhook in Mesakem Settings',
				displayOptions: { show: { registration: ['manual'] } },
			},
			{
				displayName: 'Only Meetings From',
				name: 'sources',
				type: 'multiOptions',
				default: [],
				options: SOURCE_OPTIONS,
				description: 'Leave empty for all sources. Mesakem filters before sending, so nothing extra is delivered.',
				displayOptions: { show: { registration: ['automatic'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Fetch Details',
						name: 'fetchDetails',
						type: 'boolean',
						default: true,
						description:
							'Whether to fetch the summary, meeting, task or transcript by ID (at most two API requests per event). Off: output only the short event.',
					},
					{
						displayName: 'Include Meeting With Summaries',
						name: 'includeMeeting',
						type: 'boolean',
						default: true,
						description: 'Whether summary events also fetch the meeting (one extra request)',
					},
					{
						displayName: 'Include Transcript Text',
						name: 'includeTranscriptText',
						type: 'boolean',
						default: false,
						description:
							'Whether transcript events also fetch the whole transcript as plain text (one extra request; cut at 200,000 characters)',
					},
					{
						displayName: 'Verify Signature',
						name: 'verifySignature',
						type: 'boolean',
						default: true,
						description:
							'Whether to drop deliveries whose Standard Webhooks signature does not match. Turn off only while debugging.',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if (isManual(this)) return true;
				const url = this.getNodeWebhookUrl('default');
				if (!url) return false;
				const stored = endpoints(this.getWorkflowStaticData('node'))[url];
				const segment = stored ? idSegment(stored.id) : null;
				if (!stored || !segment || !isWebhookSecret(stored.secret)) return false;
				const response = await mesakemRequest.call(this, {
					method: 'GET',
					path: `/webhooks/${segment}`,
					allowStatuses: [404],
					operation: { ...WEBHOOK_OPERATION, scope: 'webhooks:read' },
				});
				if (response.statusCode === 404 || !isObject(response.body)) return false;
				const endpoint = response.body;
				return (
					endpoint.url === url &&
					endpoint.enabled !== false &&
					endpoint.status !== 'disabled' &&
					sameEvents(endpoint.events, selectedEvents(this))
				);
			},

			async create(this: IHookFunctions): Promise<boolean> {
				if (isManual(this)) return true;
				const url = this.getNodeWebhookUrl('default');
				if (!url) throw new NodeOperationError(this.getNode(), 'n8n did not provide a webhook address for this trigger');
				const events = selectedEvents(this);
				if (events.length === 0) throw new NodeOperationError(this.getNode(), 'Choose at least one event');
				const store = endpoints(this.getWorkflowStaticData('node'));
				const stale = store[url];
				const staleSegment = stale ? idSegment(stale.id) : null;
				if (staleSegment) {
					// Settings changed (or the endpoint was disabled): replace it, never leave two behind.
					await mesakemRequest.call(this, {
						method: 'DELETE',
						path: `/webhooks/${staleSegment}`,
						allowStatuses: [404],
						operation: WEBHOOK_OPERATION,
					});
					delete store[url];
				}
				const sources = this.getNodeParameter('sources', []) as string[];
				const workflow = this.getWorkflow();
				const label = str(workflow.name) ?? str(workflow.id) ?? 'workflow';
				const body: IDataObject = {
					url,
					events,
					description: `n8n: ${label}`.slice(0, 200),
					signature_format: 'standard',
				};
				if (Array.isArray(sources) && sources.length) body.filters = { sources };
				const endpoint = await mesakemJson.call(this, { method: 'POST', path: '/webhooks', body, operation: WEBHOOK_OPERATION });
				if (typeof endpoint.id !== 'string' || !isWebhookSecret(endpoint.secret)) {
					throw new NodeOperationError(this.getNode(), 'Mesakem did not return a webhook endpoint with a signing secret');
				}
				store[url] = { id: endpoint.id, secret: endpoint.secret, events };
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				if (isManual(this)) return true;
				const url = this.getNodeWebhookUrl('default');
				if (!url) return true;
				const store = endpoints(this.getWorkflowStaticData('node'));
				const stored = store[url];
				const segment = stored ? idSegment(stored.id) : null;
				if (segment) {
					// 404 = already deleted in Mesakem Settings: nothing left to clean up.
					await mesakemRequest.call(this, {
						method: 'DELETE',
						path: `/webhooks/${segment}`,
						allowStatuses: [404],
						operation: WEBHOOK_OPERATION,
					});
				}
				delete store[url];
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const verify = options.verifySignature !== false;
		const body = rawBodyOf(this);
		let verified = false;
		if (verify) {
			const secrets = isManual(this)
				? [String(this.getNodeParameter('signingSecret', '') ?? '').trim()]
				: Object.values(endpoints(this.getWorkflowStaticData('node'))).map((endpoint) => endpoint.secret);
			const usable = secrets.filter(isWebhookSecret);
			if (usable.length === 0) {
				this.logger.warn('Mesakem Trigger: no signing secret is stored. Deactivate and activate the workflow (or paste the secret for Manual registration).');
				return reject(this, 401, 'no_signing_secret');
			}
			const headers = webhookHeaders(this.getHeaderData());
			verified = usable.some((secret) => verifyStandardWebhook({ secret, headers, body }));
			if (!verified) {
				this.logger.warn('Mesakem Trigger: dropped a delivery whose webhook signature did not verify.');
				return reject(this, 401, 'invalid_signature');
			}
		}

		let envelope: unknown;
		try {
			envelope = JSON.parse(body);
		} catch {
			envelope = this.getBodyData();
		}
		if (!isObject(envelope) || typeof envelope.type !== 'string') return reject(this, 400, 'not_a_mesakem_event');
		const type = envelope.type;
		const event = envelope as IDataObject;

		if (type === TEST_EVENT) {
			// "Send test" in Mesakem Settings: shown while listening for a test event, never runs an active workflow.
			if (this.getMode() === 'manual') return { workflowData: [[{ json: eventBase(event, verified) }]] };
			return { webhookResponse: { received: true, ignored: TEST_EVENT } };
		}

		const wanted = selectedEvents(this);
		if (wanted.length > 0 && !wanted.includes(type)) return { webhookResponse: { received: true, ignored: type } };

		const items =
			options.fetchDetails === false
				? [eventBase(event, verified)]
				: await hydrateEvent.call(this, event, verified, {
						includeMeeting: options.includeMeeting !== false,
						includeTranscriptText: options.includeTranscriptText === true,
					});
		return { workflowData: [items.map((json) => ({ json }))] };
	}
}
