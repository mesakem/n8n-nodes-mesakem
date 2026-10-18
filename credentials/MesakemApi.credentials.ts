import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MesakemApi implements ICredentialType {
	name = 'mesakemApi';

	displayName = 'Mesakem API';

	icon: Icon = { light: 'file:../icons/mesakem.svg', dark: 'file:../icons/mesakem.dark.svg' };

	documentationUrl = 'https://mesakem.com/en/developers';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create a key in Mesakem → Settings → API & webhooks. It starts with msk_live_ (or msk_org_ for an organization key). Free and trial keys can read; changing data and automatic triggers need a paid plan.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://mesakem.com/api/v1',
			description:
				'Leave as is. Change it only to test against another Mesakem server, for example https://staging.mesakem.com/api/v1.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/me',
			method: 'GET',
		},
	};
}
