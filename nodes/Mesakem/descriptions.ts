import type { INodeProperties } from 'n8n-workflow';

/**
 * Parameters of the Mesakem action node, grouped by resource. Every option maps 1:1 to a public
 * API v1 query or body field (docs/api/openapi.v1.json).
 */

const show = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

function idLocator(
	name: string,
	displayName: string,
	searchListMethod: string,
	placeholder: string,
	resource: string,
	operation: string[],
	hint: string,
): INodeProperties {
	return {
		displayName,
		name,
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: hint,
		displayOptions: show(resource, operation),
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select…',
				typeOptions: { searchListMethod, searchable: true },
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder,
				validation: [
					{
						type: 'regex',
						properties: { regex: '^[A-Za-z0-9_-]{1,200}$', errorMessage: 'Not a valid Mesakem ID' },
					},
				],
			},
		],
	};
}

function limitFields(resource: string, operation: string): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: show(resource, [operation]),
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			description: 'Max number of results to return',
			displayOptions: { show: { resource: [resource], operation: [operation], returnAll: [false] } },
		},
	];
}

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Account', value: 'me', description: 'The API key, its user and plan' },
		{ name: 'Document', value: 'document', description: 'A summary document' },
		{ name: 'Meeting', value: 'meeting' },
		{ name: 'Notetaker', value: 'bot', description: 'Send, schedule or cancel the Mesakem notetaker' },
		{ name: 'Task', value: 'task' },
	],
	default: 'meeting',
};

export const operationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['meeting'] } },
		options: [
			{ name: 'Get', value: 'get', action: 'Get a meeting', description: 'Get one meeting' },
			{ name: 'Get Many', value: 'getAll', action: 'Get many meetings', description: 'List your meetings, newest first' },
			{ name: 'Get Summary', value: 'summary', action: 'Get a meeting summary', description: 'Get the summary of a meeting' },
			{ name: 'Get Transcript', value: 'transcript', action: 'Get a meeting transcript', description: 'Get the transcript of a meeting' },
			{ name: 'Get Upcoming', value: 'upcoming', action: 'Get upcoming meetings', description: 'List upcoming calendar meetings' },
		],
		default: 'get',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['task'] } },
		options: [
			{ name: 'Create', value: 'create', action: 'Create a task', description: 'Create a task (paid plan)' },
			{ name: 'Delete', value: 'delete', action: 'Delete a task', description: 'Cancel a task (paid plan). Mesakem keeps it with status cancelled.' },
			{ name: 'Get', value: 'get', action: 'Get a task', description: 'Get one task with its checklist items' },
			{ name: 'Get Many', value: 'getAll', action: 'Get many tasks', description: 'List your tasks' },
			{ name: 'Update', value: 'update', action: 'Update a task', description: 'Change the title, description or status (paid plan)' },
		],
		default: 'get',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['bot'] } },
		options: [
			{ name: 'Cancel', value: 'cancel', action: 'Cancel the notetaker', description: 'Skip an upcoming meeting, or make the notetaker leave a meeting now (paid plan)' },
			{ name: 'Schedule', value: 'schedule', action: 'Schedule the notetaker', description: 'Have the notetaker join an upcoming calendar meeting (paid plan)' },
			{ name: 'Send', value: 'send', action: 'Send the notetaker to a meeting', description: 'Send the notetaker to a meeting link now or at a set time (paid plan)' },
		],
		default: 'send',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['document'] } },
		options: [{ name: 'Get', value: 'get', action: 'Get a document', description: 'Get a summary document' }],
		default: 'get',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['me'] } },
		options: [{ name: 'Get', value: 'get', action: 'Get the account of this key', description: 'Check the key: its user, plan, scopes and limits' }],
		default: 'get',
	},
];

const meetingId = (operation: string[]) =>
	idLocator('meetingId', 'Meeting', 'searchMeetings', 'run_…', 'meeting', operation, 'The meeting (ID starts with run_)');

export const meetingProperties: INodeProperties[] = [
	meetingId(['get', 'summary', 'transcript']),
	{
		displayName: 'Include',
		name: 'expand',
		type: 'multiOptions',
		default: [],
		description: 'Extra details to include',
		displayOptions: show('meeting', ['get']),
		options: [
			{ name: 'Participants', value: 'participants' },
			{ name: 'Documents', value: 'documents' },
		],
	},
	...limitFields('meeting', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('meeting', ['getAll']),
		options: [
			{
				displayName: 'From',
				name: 'from',
				type: 'dateTime',
				default: '',
				description: 'Only meetings that start at or after this time',
			},
			{
				displayName: 'Include',
				name: 'expand',
				type: 'multiOptions',
				default: [],
				options: [
					{ name: 'Participants', value: 'participants' },
					{ name: 'Documents', value: 'documents' },
				],
			},
			{
				displayName: 'Order',
				name: 'order',
				type: 'options',
				default: 'recent',
				options: [
					{ name: 'Most Recent First', value: 'recent' },
					{ name: 'Recently Updated First', value: 'updated' },
				],
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'completed',
				options: [
					{ name: 'Completed', value: 'completed' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Processing', value: 'processing' },
					{ name: 'Scheduled', value: 'scheduled' },
				],
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'dateTime',
				default: '',
				description: 'Only meetings that start before this time',
			},
			{
				displayName: 'Updated Since',
				name: 'updated_since',
				type: 'dateTime',
				default: '',
			},
		],
	},
	{
		displayName: 'Format',
		name: 'transcriptFormat',
		type: 'options',
		default: 'text',
		displayOptions: show('meeting', ['transcript']),
		options: [
			{ name: 'Plain Text', value: 'text', description: 'One line per speaker turn' },
			{ name: 'JSON Segments', value: 'json', description: 'Speakers, segments and timings' },
			{ name: 'WebVTT Subtitles', value: 'vtt' },
			{ name: 'SRT Subtitles', value: 'srt' },
		],
	},
	{
		displayName: 'Return All Segments',
		name: 'returnAllSegments',
		type: 'boolean',
		default: true,
		description: 'Whether to fetch every segment page (one request per 100 segments) or only the first page',
		displayOptions: { show: { resource: ['meeting'], operation: ['transcript'], transcriptFormat: ['json'] } },
	},
	{
		displayName: 'Format',
		name: 'summaryFormat',
		type: 'options',
		default: 'json',
		displayOptions: show('meeting', ['summary']),
		options: [
			{ name: 'Structured (JSON)', value: 'json', description: 'Overview, sections, action items, decisions and more' },
			{ name: 'Markdown', value: 'markdown' },
			{ name: 'HTML', value: 'html' },
			{ name: 'Plain Text', value: 'text' },
		],
	},
	...limitFields('meeting', 'upcoming'),
	{
		displayName: 'Filters',
		name: 'upcomingFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('meeting', ['upcoming']),
		options: [
			{
				displayName: 'Within Hours',
				name: 'within_hours',
				type: 'number',
				default: 336,
				typeOptions: { minValue: 1, maxValue: 8760 },
				description: 'How far ahead to look, in hours (default two weeks)',
			},
			{ displayName: 'From', name: 'from', type: 'dateTime', default: '' },
			{ displayName: 'To', name: 'to', type: 'dateTime', default: '' },
		],
	},
];

const taskId = (operation: string[]) =>
	idLocator('taskId', 'Task', 'searchTasks', 'task_…', 'task', operation, 'The task');

const TASK_STATUS_OPTIONS = [
	{ name: 'Cancelled', value: 'cancelled' },
	{ name: 'Delegated', value: 'delegated' },
	{ name: 'Done', value: 'done' },
	{ name: 'In Progress', value: 'in_progress' },
	{ name: 'Open', value: 'open' },
	{ name: 'Snoozed', value: 'snoozed' },
];

export const taskProperties: INodeProperties[] = [
	taskId(['get', 'update', 'delete']),
	{
		displayName: 'This cancels the task. Mesakem keeps it, with status "cancelled".',
		name: 'deleteNotice',
		type: 'notice',
		default: '',
		displayOptions: show('task', ['delete']),
	},
	...limitFields('task', 'getAll'),
	{
		displayName: 'Filters',
		name: 'taskFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('task', ['getAll']),
		options: [
			{ displayName: 'Due After', name: 'due_after', type: 'dateTime', default: '' },
			{ displayName: 'Due Before', name: 'due_before', type: 'dateTime', default: '' },
			{
				displayName: 'Meeting ID',
				name: 'meeting_id',
				type: 'string',
				default: '',
				placeholder: 'run_…',
				description: 'Only tasks that came from this meeting',
			},
			{
				displayName: 'Order',
				name: 'order',
				type: 'options',
				default: 'recent',
				options: [
					{ name: 'Most Recent First', value: 'recent' },
					{ name: 'Recently Updated First', value: 'updated' },
				],
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				default: 'meeting_summary',
				options: [
					{ name: 'Assistant Chat', value: 'agent_chat' },
					{ name: 'Call Summary', value: 'call_summary' },
					{ name: 'Created by Hand', value: 'manual' },
					{ name: 'Meeting Summary', value: 'meeting_summary' },
				],
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'active',
				options: [
					{ name: 'Active (Open, In Progress, Snoozed, Delegated)', value: 'active' },
					{ name: 'All', value: 'all' },
					...TASK_STATUS_OPTIONS,
				],
			},
			{ displayName: 'Updated Since', name: 'updated_since', type: 'dateTime', default: '' },
		],
	},
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { maxLength: 180 },
		displayOptions: show('task', ['create']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('task', ['create']),
		options: [
			{ displayName: 'Assignee Email', name: 'assigneeEmail', type: 'string', placeholder: 'name@email.com', default: '' },
			{ displayName: 'Assignee Name', name: 'assigneeName', type: 'string', default: '' },
			{
				displayName: 'Checklist Items',
				name: 'items',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'One item per line (up to 24)',
			},
			{ displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 3 }, default: '' },
			{ displayName: 'Due At', name: 'dueAt', type: 'dateTime', default: '' },
			{ displayName: 'Status', name: 'status', type: 'options', default: 'open', options: TASK_STATUS_OPTIONS },
		],
	},
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('task', ['update']),
		options: [
			{ displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 3 }, default: '' },
			{ displayName: 'Status', name: 'status', type: 'options', default: 'done', options: TASK_STATUS_OPTIONS },
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
		],
	},
	{
		displayName: 'Options',
		name: 'taskOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('task', ['get']),
		options: [
			{
				displayName: 'Checklist Items Limit',
				name: 'items_limit',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 1, maxValue: 500 },
			},
		],
	},
];

export const botProperties: INodeProperties[] = [
	{
		displayName: 'Each notetaker uses your plan\'s meeting quota. Mesakem also limits how many it sends per minute, hour and day.',
		name: 'botNotice',
		type: 'notice',
		default: '',
		displayOptions: show('bot', ['send', 'schedule']),
	},
	{
		displayName: 'Meeting Link',
		name: 'meetingUrl',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'https://meet.google.com/abc-defg-hij',
		description: 'A Zoom, Google Meet or Microsoft Teams link (a pasted invitation works too)',
		displayOptions: show('bot', ['send']),
	},
	{
		displayName: 'Additional Fields',
		name: 'botFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('bot', ['send']),
		options: [
			{ displayName: 'End Time', name: 'end_time', type: 'dateTime', default: '' },
			{
				displayName: 'Language',
				name: 'language',
				type: 'string',
				default: '',
				placeholder: 'he, en or auto',
				description: 'Conversation language. Default: your saved notetaker language.',
			},
			{
				displayName: 'Start Time',
				name: 'start_time',
				type: 'dateTime',
				default: '',
				description: 'Join at this time instead of now (up to 60 days ahead)',
			},
			{
				displayName: 'Summary Language',
				name: 'summary_language',
				type: 'options',
				default: 'he',
				options: [
					{ name: 'English', value: 'en' },
					{ name: 'Hebrew', value: 'he' },
				],
			},
			{
				displayName: 'Summary Recipient Email',
				name: 'summary_recipient_email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				description: 'A verified summary recipient of your workspace. Default: you.',
			},
			{ displayName: 'Title', name: 'title', type: 'string', default: '' },
		],
	},
	idLocator(
		'eventId',
		'Upcoming Meeting',
		'searchUpcomingMeetings',
		'cal_evt_…',
		'bot',
		['schedule'],
		'The calendar meeting (ID starts with cal_evt_)',
	),
	{
		displayName: 'Meeting',
		name: 'cancelTarget',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description:
			'An upcoming calendar meeting (cal_evt_…) to skip, or a meeting in progress (run_…) for the notetaker to leave now',
		displayOptions: show('bot', ['cancel']),
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select an upcoming meeting…',
				typeOptions: { searchListMethod: 'searchUpcomingMeetings', searchable: true },
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'cal_evt_… or run_…',
				validation: [
					{
						type: 'regex',
						properties: { regex: '^[A-Za-z0-9_-]{1,200}$', errorMessage: 'Not a valid Mesakem ID' },
					},
				],
			},
		],
	},
	{
		displayName: 'Apply to Series',
		name: 'applyToSeries',
		type: 'boolean',
		default: false,
		description: 'Whether to also apply this to every future meeting of the recurring series (calendar meetings only)',
		displayOptions: show('bot', ['schedule', 'cancel']),
	},
];

export const documentProperties: INodeProperties[] = [
	{
		displayName: 'Document ID',
		name: 'documentId',
		type: 'string',
		required: true,
		default: '',
		description: 'From a summary\'s "documents" list, or a meeting fetched with Include → Documents',
		displayOptions: show('document', ['get']),
	},
	{
		displayName: 'Format',
		name: 'documentFormat',
		type: 'options',
		default: 'json',
		displayOptions: show('document', ['get']),
		options: [
			{ name: 'HTML', value: 'html' },
			{ name: 'JSON', value: 'json' },
			{ name: 'Markdown', value: 'markdown' },
			{ name: 'Plain Text', value: 'text' },
			{ name: 'Raw', value: 'raw' },
		],
	},
];
