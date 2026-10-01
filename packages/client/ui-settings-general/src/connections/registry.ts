/**
 * The connection registry: which services General Settings offers, and the real
 * sign-in program each one runs.
 *
 * A recipe is data about a protocol this plugin actually implements — OAuth 2.0
 * authorization code with PKCE over the harness's own web server, RFC 8628
 * device authorization, a verified token or app password, or an installed
 * provider CLI. Curated entries carry the provider's real endpoints, scopes and
 * profile call, so the account label shown after connecting is read from the
 * provider rather than guessed.
 *
 * The catalog keeps its full breadth: a service with no curated entry still
 * appears, with a generic token method that is explicitly reported as saved
 * rather than verified. Nothing here offers a step the plugin cannot complete.
 *
 * @module
 */

/** How one method obtains its credential. */
export type MethodKind = 'oauth' | 'device' | 'token' | 'cli'

/** One HTTP call that proves a credential works and names the account. */
export interface ProfileRequest {
  /** Absolute URL; `{secret}` and `{account}` are substituted from the answer. */
  readonly url: string
  /** Defaults to GET. */
  readonly method?: 'GET' | 'POST'
  /** Header values; `{secret}` and `{account}` are substituted. */
  readonly headers?: Readonly<Record<string, string>>
  /** Request body for POST profile calls. */
  readonly body?: string
  /** Dot path into the JSON response naming the account. */
  readonly accountPath?: string
  /** Response header naming the account, used when no path matches. */
  readonly accountHeader?: string
}

/** OAuth 2.0 authorization code + PKCE. */
export interface OAuthMethod {
  readonly kind: 'oauth'
  readonly id: string
  readonly label: string
  /** Where the browser is sent to sign in. */
  readonly authorizeUrl: string
  /** Where the authorization code is exchanged for tokens. */
  readonly tokenUrl: string
  readonly scopes: readonly string[]
  /** Environment variable that may carry the client id instead of the stored app. */
  readonly clientIdEnv: string
  /** A client id KairoForge can present without asking, when one exists. */
  readonly clientId?: string
  /** Whether the provider requires a client secret (false for public clients). */
  readonly secretRequired?: boolean
  /** How client credentials reach the token endpoint. Defaults to `body`. */
  readonly tokenAuth?: 'basic' | 'body'
  /** How the token endpoint answers. Defaults to `json`. */
  readonly tokenFormat?: 'json' | 'form'
  /** Extra authorize-URL parameters (audience, prompt, access_type…). */
  readonly extraAuthParams?: Readonly<Record<string, string>>
  /** Proves the grant and names the account. */
  readonly profile?: ProfileRequest
  /** Where the operator registers the OAuth app. */
  readonly appUrl?: string
  /** One line describing what registering the app takes. */
  readonly appHelp?: string
}

/** RFC 8628 device authorization. */
export interface DeviceMethod {
  readonly kind: 'device'
  readonly id: string
  readonly label: string
  readonly deviceUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
  readonly clientIdEnv: string
  readonly clientId?: string
  /** How the token endpoint answers. Defaults to `json`. */
  readonly tokenFormat?: 'json' | 'form'
  readonly profile?: ProfileRequest
  /** Where the operator registers the OAuth app. */
  readonly appUrl?: string
}

/** One field a token or app-password method asks for. */
export interface TokenField {
  readonly id: 'account' | 'secret'
  readonly label: string
  readonly kind: 'text' | 'secret'
  readonly placeholder?: string
  readonly help?: string
}

/** App-password verification over IMAP, used where a mailbox is the credential. */
export interface ImapVerify {
  readonly host: string
  readonly port: number
}

/** A token or app password, verified against the provider when verification exists. */
export interface TokenMethod {
  readonly kind: 'token'
  readonly id: string
  readonly label: string
  /** The provider page that creates the credential. */
  readonly createUrl: string
  readonly fields: readonly TokenField[]
  /** Proves the credential and names the account, when the provider allows it. */
  readonly profile?: ProfileRequest
  /** Mailbox credentials prove themselves by logging in. */
  readonly imap?: ImapVerify
  readonly help?: string
}

/** A provider CLI that performs its own browser sign-in. */
export interface CliMethod {
  readonly kind: 'cli'
  readonly id: string
  readonly label: string
  /** Executable name looked up on PATH. */
  readonly executable: string
  /** Arguments that run the interactive sign-in. */
  readonly loginArgs: readonly string[]
  /** Arguments whose output proves the sign-in and names the account. */
  readonly verifyArgs: readonly string[]
  readonly installUrl?: string
}

/** One way to connect a service. */
export type Method = OAuthMethod | DeviceMethod | TokenMethod | CliMethod

/** One connectable service. */
export interface ServiceRecipe {
  readonly id: string
  readonly name: string
  readonly category: string
  /** Most preferred first; never empty. */
  readonly methods: readonly [Method, ...Method[]]
}

/** Service names per category. Curated recipes attach to these by exact name. */
const CATEGORY_NAMES: Readonly<Record<string, readonly string[]>> = {
  'Code & work': ['GitHub', 'GitLab', 'Bitbucket', 'Azure DevOps', 'Gitea', 'SourceForge', 'Codeberg', 'Linear', 'Jira', 'Trello', 'Asana', 'ClickUp', 'Monday.com', 'Notion', 'Coda', 'Airtable', 'Confluence', 'Shortcut', 'Height', 'Basecamp', 'YouTrack', 'Sentry', 'Datadog', 'New Relic', 'Grafana', 'PagerDuty', 'Opsgenie', 'Statuspage', 'LaunchDarkly', 'PostHog'],
  'Email & calendar': ['Gmail', 'Google Calendar', 'Google Contacts', 'Google Drive', 'Google Docs', 'Google Sheets', 'Google Slides', 'Google Forms', 'Google Tasks', 'Google Keep', 'Google Meet', 'Outlook Mail', 'Outlook Calendar', 'Microsoft OneDrive', 'Microsoft SharePoint', 'Microsoft Teams', 'Microsoft To Do', 'Microsoft Planner', 'Exchange', 'Yahoo Mail', 'iCloud Mail', 'Fastmail', 'Proton Mail', 'Zoho Mail', 'Superhuman', 'Calendly', 'Cal.com', 'Doodle', 'Acuity Scheduling', 'SavvyCal'],
  'Chat & social': ['Slack', 'Discord', 'Telegram', 'WhatsApp Business', 'Signal', 'Messenger', 'Instagram', 'Facebook Pages', 'Facebook Groups', 'X / Twitter', 'LinkedIn', 'LinkedIn Pages', 'Reddit', 'YouTube', 'TikTok', 'Pinterest', 'Snapchat', 'Threads', 'Mastodon', 'Bluesky', 'Twitch', 'Zoom', 'Webex', 'Google Chat', 'Mattermost', 'Rocket.Chat', 'Twilio', 'SendGrid', 'Mailchimp', 'Constant Contact'],
  'Files & design': ['Dropbox', 'Box', 'MEGA', 'pCloud', 'Backblaze B2', 'Wasabi', 'Amazon S3', 'Google Cloud Storage', 'Azure Blob Storage', 'Cloudflare R2', 'DigitalOcean Spaces', 'Firebase Storage', 'Supabase Storage', 'Imgur', 'Cloudinary', 'ImageKit', 'Filestack', 'DocuSign', 'Dropbox Sign', 'PandaDoc', 'Adobe Acrobat Sign', 'Canva', 'Figma', 'FigJam', 'Miro', 'Mural', 'Lucidchart', 'Whimsical', 'Excalidraw', 'Draw.io'],
  'Sales & finance': ['Stripe', 'PayPal', 'Square', 'Shopify', 'WooCommerce', 'BigCommerce', 'Etsy', 'eBay', 'Amazon Seller Central', 'Walmart Marketplace', 'Gumroad', 'Lemon Squeezy', 'Paddle', 'Chargebee', 'Recurly', 'QuickBooks', 'Xero', 'FreshBooks', 'Wave', 'Plaid', 'Wise', 'Mercury', 'Brex', 'Ramp', 'Expensify', 'Bill.com', 'Netsuite', 'Sage', 'Odoo', 'SAP'],
  'CRM & marketing': ['Salesforce', 'HubSpot', 'Pipedrive', 'Zendesk', 'Intercom', 'Freshdesk', 'Help Scout', 'Front', 'Kustomer', 'Gorgias', 'ServiceNow', 'Dynamics 365', 'Zoho CRM', 'Close', 'Copper', 'Keap', 'ActiveCampaign', 'Customer.io', 'Klaviyo', 'Braze', 'Iterable', 'Segment', 'Amplitude', 'Mixpanel', 'Heap', 'Hotjar', 'FullStory', 'Google Analytics', 'Google Ads', 'Meta Ads'],
  'AI & data': ['OpenAI', 'Anthropic', 'Google Gemini', 'Mistral AI', 'Cohere', 'DeepSeek', 'Groq', 'Together AI', 'Replicate', 'Hugging Face', 'Perplexity', 'ElevenLabs', 'AssemblyAI', 'Deepgram', 'Pinecone', 'Weaviate', 'Qdrant', 'Milvus', 'Chroma', 'LangSmith', 'Weights & Biases', 'Comet', 'Modal', 'RunPod', 'Baseten', 'Anyscale', 'Fal.ai', 'Stability AI', 'Leonardo AI', 'Midjourney'],
  'Cloud & devops': ['AWS', 'Google Cloud', 'Microsoft Azure', 'Vercel', 'Netlify', 'Cloudflare', 'Render', 'Railway', 'Fly.io', 'Heroku', 'DigitalOcean', 'Linode', 'Vultr', 'Kubernetes', 'Docker Hub', 'GitHub Actions', 'CircleCI', 'Travis CI', 'Jenkins', 'Buildkite', 'Terraform Cloud', 'Pulumi', 'MongoDB Atlas', 'Supabase', 'Neon', 'PlanetScale', 'Redis Cloud', 'Upstash', 'Elastic Cloud', 'Snowflake'],
  'Automation & web': ['Zapier', 'Make', 'n8n', 'IFTTT', 'Workato', 'Tray.io', 'Pabbly Connect', 'Retool', 'Appsmith', 'Budibase', 'Typeform', 'Jotform', 'Tally', 'Fillout', 'Paperform', 'Webflow', 'Wix', 'Squarespace', 'WordPress', 'Ghost', 'Contentful', 'Sanity', 'Strapi', 'Prismic', 'Shopify CMS', 'RSS', 'Webhooks', 'GraphQL APIs', 'REST APIs', 'MCP Servers'],
}

/** GitHub, shared by the code-host entry and the Actions entry. */
const GITHUB_OAUTH: OAuthMethod = {
  kind: 'oauth',
  id: 'oauth',
  label: 'Sign in with GitHub',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['read:user', 'repo', 'workflow'],
  clientIdEnv: 'KAIROFORGE_GITHUB_CLIENT_ID',
  secretRequired: true,
  tokenFormat: 'form',
  profile: { url: 'https://api.github.com/user', headers: { accept: 'application/vnd.github+json' }, accountPath: 'login' },
  appUrl: 'https://github.com/settings/developers',
  appHelp: 'New OAuth app → callback http://127.0.0.1:3080/kairoforge/connect/callback',
}

/** GitHub device authorization: the same grant without a redirect URI to match. */
const GITHUB_DEVICE: DeviceMethod = {
  kind: 'device',
  id: 'device',
  label: 'Sign in with a code',
  deviceUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['read:user', 'repo'],
  clientIdEnv: 'KAIROFORGE_GITHUB_CLIENT_ID',
  tokenFormat: 'form',
  profile: { url: 'https://api.github.com/user', headers: { accept: 'application/vnd.github+json' }, accountPath: 'login' },
  appUrl: 'https://github.com/settings/developers',
}

/** GitHub personal access token, verified through the REST API. */
const GITHUB_TOKEN: TokenMethod = {
  kind: 'token',
  id: 'token',
  label: 'Use a personal access token',
  createUrl: 'https://github.com/settings/tokens',
  fields: [{ id: 'secret', kind: 'secret', label: 'GitHub token', placeholder: 'ghp_…' }],
  profile: { url: 'https://api.github.com/user', headers: { accept: 'application/vnd.github+json' }, accountPath: 'login' },
}

/** Google OAuth endpoints, shared by every Google service. */
function googleOAuth(service: string, scopes: readonly string[], label: string): OAuthMethod {
  return {
    kind: 'oauth',
    id: 'oauth',
    label,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes,
    clientIdEnv: `KAIROFORGE_GOOGLE_CLIENT_ID_${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    secretRequired: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    profile: { url: 'https://openidconnect.googleapis.com/v1/userinfo', accountPath: 'email' },
    appUrl: 'https://console.cloud.google.com/apis/credentials',
    appHelp: 'Create an OAuth client of type Desktop app; loopback redirects are allowed on any port.',
  }
}

/** Microsoft identity platform, shared by every Microsoft 365 service. */
function microsoftOAuth(scopes: readonly string[], label: string): OAuthMethod {
  return {
    kind: 'oauth',
    id: 'oauth',
    label,
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [...scopes, 'offline_access', 'openid', 'profile', 'email'],
    clientIdEnv: 'KAIROFORGE_MICROSOFT_CLIENT_ID',
    secretRequired: false,
    extraAuthParams: { response_mode: 'query' },
    profile: { url: 'https://graph.microsoft.com/v1.0/me', accountPath: 'userPrincipalName' },
    appUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    appHelp: 'Register an app, add a Mobile and desktop application platform, then allow public client flows.',
  }
}

/** A provider token whose only proof is that the provider accepts it. */
function apiToken(
  label: string,
  createUrl: string,
  placeholder: string,
  profile: ProfileRequest,
): TokenMethod {
  return {
    kind: 'token',
    id: 'token',
    label,
    createUrl,
    fields: [{ id: 'secret', kind: 'secret', label, placeholder }],
    profile,
  }
}

/** Bearer-token profile call for providers with a plain `whoami` endpoint. */
function bearer(url: string, accountPath?: string): ProfileRequest {
  return accountPath === undefined ? { url } : { url, accountPath }
}

/** The Google mailbox path: an app password, proven by an IMAP login. */
function mailboxMethod(id: string, label: string, host: string, createUrl: string, help: string): TokenMethod {
  return {
    kind: 'token',
    id,
    label,
    createUrl,
    help,
    imap: { host, port: 993 },
    fields: [
      { id: 'account', kind: 'text', label: 'Email address', placeholder: 'you@example.com' },
      { id: 'secret', kind: 'secret', label: 'App password', placeholder: 'xxxx xxxx xxxx xxxx' },
    ],
  }
}

/** Every curated recipe, keyed by the exact catalog name. */
const RECIPES: Readonly<Record<string, readonly Method[]>> = {
  GitHub: [GITHUB_TOKEN, GITHUB_DEVICE, GITHUB_OAUTH],
  'GitHub Actions': [GITHUB_TOKEN, GITHUB_DEVICE, GITHUB_OAUTH],
  GitLab: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with GitLab',
      authorizeUrl: 'https://gitlab.com/oauth/authorize', tokenUrl: 'https://gitlab.com/oauth/token',
      scopes: ['read_api', 'read_user'], clientIdEnv: 'KAIROFORGE_GITLAB_CLIENT_ID', secretRequired: true,
      profile: bearer('https://gitlab.com/api/v4/user', 'username'),
      appUrl: 'https://gitlab.com/-/user_settings/applications',
    },
    apiToken('GitLab token', 'https://gitlab.com/-/user_settings/personal_access_tokens', 'glpat-…', bearer('https://gitlab.com/api/v4/user', 'username')),
  ],
  Linear: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Linear',
      authorizeUrl: 'https://linear.app/oauth/authorize', tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read'], clientIdEnv: 'KAIROFORGE_LINEAR_CLIENT_ID', secretRequired: true,
      profile: { url: 'https://api.linear.app/graphql', method: 'POST', body: '{"query":"{viewer{name email}}"}' },
      appUrl: 'https://linear.app/settings/api/applications/new',
    },
    apiToken('Linear API key', 'https://linear.app/settings/api', 'lin_api_…', { url: 'https://api.linear.app/graphql', method: 'POST', body: '{"query":"{viewer{name email}}"}' }),
  ],
  Jira: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Atlassian',
      authorizeUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
      extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' },
      clientIdEnv: 'KAIROFORGE_ATLASSIAN_CLIENT_ID', secretRequired: true,
      profile: bearer('https://api.atlassian.com/me', 'email'),
      appUrl: 'https://developer.atlassian.com/console/myapps/',
    },
  ],
  Confluence: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Atlassian',
      authorizeUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:content:confluence', 'offline_access'],
      extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' },
      clientIdEnv: 'KAIROFORGE_ATLASSIAN_CLIENT_ID', secretRequired: true,
      profile: bearer('https://api.atlassian.com/me', 'email'),
      appUrl: 'https://developer.atlassian.com/console/myapps/',
    },
  ],
  Notion: [
    apiToken('Notion integration token', 'https://www.notion.so/my-integrations', 'ntn_…', {
      url: 'https://api.notion.com/v1/users/me', headers: { 'notion-version': '2022-06-28' }, accountPath: 'name',
    }),
  ],
  Airtable: [
    apiToken('Airtable token', 'https://airtable.com/create/tokens', 'pat…', bearer('https://api.airtable.com/v0/meta/whoami', 'email')),
  ],
  Sentry: [
    apiToken('Sentry auth token', 'https://sentry.io/settings/account/api/auth-tokens/', 'sntrys_…', bearer('https://sentry.io/api/0/users/me/', 'email')),
  ],
  Datadog: [
    apiToken('Datadog API key', 'https://app.datadoghq.com/organization-settings/api-keys', 'dd-api-key', {
      url: 'https://api.datadoghq.com/api/v1/validate', headers: { 'dd-api-key': '{secret}' },
    }),
  ],
  PagerDuty: [
    apiToken('PagerDuty API key', 'https://support.pagerduty.com/main/docs/api-access-keys', 'u+…', bearer('https://api.pagerduty.com/users/me', 'user.name')),
  ],
  'Terraform Cloud': [
    apiToken('Terraform Cloud token', 'https://app.terraform.io/app/settings/tokens', 'atlasv1.…', bearer('https://app.terraform.io/api/v2/account/details', 'data.attributes.username')),
  ],
  CircleCI: [
    apiToken('CircleCI token', 'https://app.circleci.com/settings/user/tokens', 'circle-token', {
      url: 'https://circleci.com/api/v2/me', headers: { 'circle-token': '{secret}' }, accountPath: 'name',
    }),
  ],
  Gmail: [
    mailboxMethod('app-password', 'Sign in with a Google app password', 'imap.gmail.com', 'https://myaccount.google.com/apppasswords', 'Requires 2-step verification on the Google account.'),
    googleOAuth('GMAIL', ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], 'Sign in with Google'),
  ],
  'Google Calendar': [googleOAuth('CALENDAR', ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'], 'Sign in with Google')],
  'Google Contacts': [googleOAuth('CONTACTS', ['https://www.googleapis.com/auth/contacts.readonly'], 'Sign in with Google')],
  'Google Drive': [googleOAuth('DRIVE', ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'], 'Sign in with Google')],
  'Google Docs': [googleOAuth('DOCS', ['https://www.googleapis.com/auth/documents.readonly', 'https://www.googleapis.com/auth/drive.file'], 'Sign in with Google')],
  'Google Sheets': [googleOAuth('SHEETS', ['https://www.googleapis.com/auth/spreadsheets.readonly'], 'Sign in with Google')],
  'Google Slides': [googleOAuth('SLIDES', ['https://www.googleapis.com/auth/presentations.readonly'], 'Sign in with Google')],
  'Google Tasks': [googleOAuth('TASKS', ['https://www.googleapis.com/auth/tasks.readonly'], 'Sign in with Google')],
  'Google Analytics': [googleOAuth('ANALYTICS', ['https://www.googleapis.com/auth/analytics.readonly'], 'Sign in with Google')],
  'Google Ads': [googleOAuth('ADS', ['https://www.googleapis.com/auth/adwords'], 'Sign in with Google')],
  'Google Gemini': [
    apiToken('Gemini API key', 'https://aistudio.google.com/apikey', 'AIza…', bearer('https://generativelanguage.googleapis.com/v1beta/models?key={secret}')),
  ],
  'Google Cloud': [
    {
      kind: 'cli', id: 'cli', label: 'Sign in with the Google Cloud CLI', executable: 'gcloud',
      loginArgs: ['auth', 'login'], verifyArgs: ['config', 'get-value', 'account'],
      installUrl: 'https://cloud.google.com/sdk/docs/install',
    },
  ],
  'Outlook Mail': [microsoftOAuth(['Mail.Read'], 'Sign in with Microsoft')],
  'Outlook Calendar': [microsoftOAuth(['Calendars.Read'], 'Sign in with Microsoft')],
  'Microsoft OneDrive': [microsoftOAuth(['Files.Read'], 'Sign in with Microsoft')],
  'Microsoft Teams': [microsoftOAuth(['Chat.Read'], 'Sign in with Microsoft')],
  'Microsoft SharePoint': [microsoftOAuth(['Sites.Read.All'], 'Sign in with Microsoft')],
  'Microsoft To Do': [microsoftOAuth(['Tasks.Read'], 'Sign in with Microsoft')],
  'Microsoft Planner': [microsoftOAuth(['Tasks.Read'], 'Sign in with Microsoft')],
  Exchange: [microsoftOAuth(['Mail.Read'], 'Sign in with Microsoft')],
  'Yahoo Mail': [mailboxMethod('app-password', 'Use a Yahoo app password', 'imap.mail.yahoo.com', 'https://login.yahoo.com/account/security', 'Generate an app password in Yahoo Account Security.')],
  'iCloud Mail': [mailboxMethod('app-password', 'Use an Apple app-specific password', 'imap.mail.me.com', 'https://account.apple.com/account/manage', 'Create an app-specific password for KairoForge.')],
  Fastmail: [mailboxMethod('app-password', 'Use a Fastmail app password', 'imap.fastmail.com', 'https://app.fastmail.com/settings/security/apppasswords', 'Create an app password with IMAP access.')],
  'Zoho Mail': [mailboxMethod('app-password', 'Use a Zoho app password', 'imap.zoho.com', 'https://accounts.zoho.com/home#security/app_password', 'Create an application-specific password.')],
  Slack: [
    apiToken('Slack bot token', 'https://api.slack.com/apps', 'xoxb-…', { url: 'https://slack.com/api/auth.test', method: 'POST', accountPath: 'user' }),
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Slack',
      authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['channels:read', 'chat:write', 'users:read', 'team:read'],
      clientIdEnv: 'KAIROFORGE_SLACK_CLIENT_ID', secretRequired: true,
      profile: { url: 'https://slack.com/api/auth.test', method: 'POST', accountPath: 'user' },
      appUrl: 'https://api.slack.com/apps',
    },
  ],
  Discord: [
    apiToken('Discord bot token', 'https://discord.com/developers/applications', 'bot token', bearer('https://discord.com/api/users/@me', 'username')),
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Discord',
      authorizeUrl: 'https://discord.com/oauth2/authorize', tokenUrl: 'https://discord.com/api/oauth2/token',
      scopes: ['identify', 'guilds'], clientIdEnv: 'KAIROFORGE_DISCORD_CLIENT_ID', secretRequired: true,
      profile: bearer('https://discord.com/api/users/@me', 'username'),
      appUrl: 'https://discord.com/developers/applications',
    },
  ],
  Telegram: [
    apiToken('Telegram bot token', 'https://t.me/BotFather', '123456:ABC-…', bearer('https://api.telegram.org/bot{secret}/getMe', 'result.username')),
  ],
  'X / Twitter': [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with X',
      authorizeUrl: 'https://twitter.com/i/oauth2/authorize', tokenUrl: 'https://api.twitter.com/2/oauth2/token',
      scopes: ['tweet.read', 'users.read', 'offline.access'], clientIdEnv: 'KAIROFORGE_X_CLIENT_ID', secretRequired: false,
      profile: bearer('https://api.twitter.com/2/users/me', 'data.username'),
      appUrl: 'https://developer.x.com/en/portal/dashboard',
    },
  ],
  Bluesky: [
    apiToken('Bluesky app password', 'https://bsky.app/settings/app-passwords', 'xxxx-xxxx-xxxx-xxxx', {
      url: 'https://bsky.social/xrpc/com.atproto.server.getSession', accountPath: 'handle',
    }),
  ],
  Zoom: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Zoom',
      authorizeUrl: 'https://zoom.us/oauth/authorize', tokenUrl: 'https://zoom.us/oauth/token',
      scopes: ['user:read'], clientIdEnv: 'KAIROFORGE_ZOOM_CLIENT_ID', secretRequired: true, tokenAuth: 'basic',
      profile: bearer('https://api.zoom.us/v2/users/me', 'email'),
      appUrl: 'https://marketplace.zoom.us/develop/create',
    },
  ],
  Twilio: [
    apiToken('Twilio auth token', 'https://console.twilio.com/', 'auth token', bearer('https://api.twilio.com/2010-04-01/Accounts.json')),
  ],
  SendGrid: [
    apiToken('SendGrid API key', 'https://app.sendgrid.com/settings/api_keys', 'SG.…', bearer('https://api.sendgrid.com/v3/user/account')),
  ],
  Mailchimp: [
    apiToken('Mailchimp API key', 'https://admin.mailchimp.com/account/api/', 'xxxxxxxx-us1', bearer('https://login.mailchimp.com/oauth2/metadata')),
  ],
  Klaviyo: [
    apiToken('Klaviyo private key', 'https://www.klaviyo.com/account#api-keys-tab', 'pk_…', bearer('https://a.klaviyo.com/api/accounts/', 'data.attributes.contact_information.default_sender_name')),
  ],
  Dropbox: [
    apiToken('Dropbox access token', 'https://www.dropbox.com/developers/apps', 'sl.…', { url: 'https://api.dropboxapi.com/2/users/get_current_account', method: 'POST', body: 'null', accountPath: 'email' }),
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Dropbox',
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize', tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: ['account_info.read', 'files.metadata.read'], clientIdEnv: 'KAIROFORGE_DROPBOX_CLIENT_ID',
      secretRequired: false, extraAuthParams: { token_access_type: 'offline' },
      profile: { url: 'https://api.dropboxapi.com/2/users/get_current_account', method: 'POST', body: 'null', accountPath: 'email' },
      appUrl: 'https://www.dropbox.com/developers/apps',
    },
  ],
  Box: [
    apiToken('Box developer token', 'https://app.box.com/developers/console', 'developer token', bearer('https://api.box.com/2.0/users/me', 'login')),
  ],
  Figma: [
    apiToken('Figma personal access token', 'https://www.figma.com/developers/api#access-tokens', 'figd_…', {
      url: 'https://api.figma.com/v1/me', headers: { 'x-figma-token': '{secret}' }, accountPath: 'email',
    }),
  ],
  Stripe: [
    apiToken('Stripe secret key', 'https://dashboard.stripe.com/apikeys', 'sk_…', bearer('https://api.stripe.com/v1/account')),
  ],
  HubSpot: [
    apiToken('HubSpot private app token', 'https://app.hubspot.com/private-apps', 'pat-…', bearer('https://api.hubapi.com/oauth/v1/access-tokens/{secret}', 'user')),
  ],
  Salesforce: [
    {
      kind: 'oauth', id: 'oauth', label: 'Sign in with Salesforce',
      authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
      scopes: ['api', 'refresh_token'], clientIdEnv: 'KAIROFORGE_SALESFORCE_CLIENT_ID', secretRequired: true,
      profile: bearer('https://login.salesforce.com/services/oauth2/userinfo', 'email'),
      appUrl: 'https://lightning.force.com/lightning/setup/ConnectedApplication/home',
    },
  ],
  OpenAI: [
    apiToken('OpenAI API key', 'https://platform.openai.com/api-keys', 'sk-…', bearer('https://api.openai.com/v1/models')),
  ],
  Anthropic: [
    apiToken('Anthropic API key', 'https://console.anthropic.com/settings/keys', 'sk-ant-…', {
      url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': '{secret}', 'anthropic-version': '2023-06-01' },
    }),
  ],
  'Mistral AI': [apiToken('Mistral API key', 'https://console.mistral.ai/api-keys/', 'api key', bearer('https://api.mistral.ai/v1/models'))],
  Cohere: [apiToken('Cohere API key', 'https://dashboard.cohere.com/api-keys', 'api key', bearer('https://api.cohere.com/v1/models'))],
  DeepSeek: [apiToken('DeepSeek API key', 'https://platform.deepseek.com/api_keys', 'sk-…', bearer('https://api.deepseek.com/user/balance'))],
  Groq: [apiToken('Groq API key', 'https://console.groq.com/keys', 'gsk_…', bearer('https://api.groq.com/openai/v1/models'))],
  'Together AI': [apiToken('Together API key', 'https://api.together.xyz/settings/api-keys', 'api key', bearer('https://api.together.xyz/v1/models'))],
  Replicate: [apiToken('Replicate API token', 'https://replicate.com/account/api-tokens', 'r8_…', bearer('https://api.replicate.com/v1/account', 'username'))],
  'Hugging Face': [
    apiToken('Hugging Face token', 'https://huggingface.co/settings/tokens', 'hf_…', bearer('https://huggingface.co/api/whoami-v2', 'name')),
  ],
  Perplexity: [apiToken('Perplexity API key', 'https://www.perplexity.ai/settings/api', 'pplx-…', bearer('https://api.perplexity.ai/models'))],
  ElevenLabs: [
    apiToken('ElevenLabs API key', 'https://elevenlabs.io/app/settings/api-keys', 'sk_…', {
      url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': '{secret}' },
    }),
  ],
  AssemblyAI: [apiToken('AssemblyAI API key', 'https://www.assemblyai.com/dashboard/signup', 'api key', { url: 'https://api.assemblyai.com/v2/account', headers: { authorization: '{secret}' } })],
  Deepgram: [
    apiToken('Deepgram API key', 'https://console.deepgram.com/', 'api key', {
      url: 'https://api.deepgram.com/v1/projects', headers: { authorization: 'Token {secret}' },
    }),
  ],
  Pinecone: [
    apiToken('Pinecone API key', 'https://app.pinecone.io/', 'api key', {
      url: 'https://api.pinecone.io/indexes', headers: { 'api-key': '{secret}' },
    }),
  ],
  'Weights & Biases': [apiToken('W&B API key', 'https://wandb.ai/authorize', 'api key', { url: 'https://api.wandb.ai/me', headers: { authorization: 'Bearer {secret}' }, accountPath: 'username' })],
  'Fal.ai': [apiToken('fal.ai key', 'https://fal.ai/dashboard/keys', 'key_id:key_secret', { url: 'https://rest.alpha.fal.ai/tokens/', headers: { authorization: 'Key {secret}' } })],
  'Stability AI': [apiToken('Stability API key', 'https://platform.stability.ai/account/keys', 'sk-…', bearer('https://api.stability.ai/v1/user/account', 'email'))],
  Vercel: [apiToken('Vercel token', 'https://vercel.com/account/tokens', 'token', bearer('https://api.vercel.com/v2/user', 'user.username'))],
  Netlify: [apiToken('Netlify token', 'https://app.netlify.com/user/applications#personal-access-tokens', 'token', bearer('https://api.netlify.com/api/v1/user', 'email'))],
  Cloudflare: [
    apiToken('Cloudflare API token', 'https://dash.cloudflare.com/profile/api-tokens', 'token', {
      url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    }),
  ],
  Render: [apiToken('Render API key', 'https://dashboard.render.com/u/settings#api-keys', 'rnd_…', bearer('https://api.render.com/v1/owners?limit=1'))],
  Railway: [apiToken('Railway token', 'https://railway.app/account/tokens', 'token', { url: 'https://backboard.railway.app/graphql/v2', method: 'POST', body: '{"query":"{me{name email}}"}' })],
  'Fly.io': [apiToken('Fly API token', 'https://fly.io/user/personal_access_tokens', 'FlyV1 …', { url: 'https://api.machines.dev/v1/apps', headers: { authorization: '{secret}' } })],
  Heroku: [apiToken('Heroku API key', 'https://dashboard.heroku.com/account', 'API key', { url: 'https://api.heroku.com/account', headers: { authorization: 'Bearer {secret}', accept: 'application/vnd.heroku+json; version=3' }, accountPath: 'email' })],
  DigitalOcean: [apiToken('DigitalOcean token', 'https://cloud.digitalocean.com/account/api/tokens', 'dop_v1_…', bearer('https://api.digitalocean.com/v2/account', 'account.email'))],
  'Docker Hub': [apiToken('Docker Hub token', 'https://hub.docker.com/settings/security', 'dckr_pat_…', { url: 'https://hub.docker.com/v2/user/', headers: { authorization: 'Bearer {secret}' }, accountPath: 'username' })],
  Supabase: [apiToken('Supabase access token', 'https://supabase.com/dashboard/account/tokens', 'sbp_…', bearer('https://api.supabase.com/v1/projects'))],
  Neon: [apiToken('Neon API key', 'https://console.neon.tech/app/settings/api-keys', 'key', bearer('https://console.neon.tech/api/v2/users/me', 'email'))],
  PlanetScale: [apiToken('PlanetScale service token', 'https://app.planetscale.com/settings/service-tokens', 'token_id:token', bearer('https://api.planetscale.com/v1/organizations'))],
  Upstash: [apiToken('Upstash management key', 'https://console.upstash.com/account/api', 'email:key', bearer('https://api.upstash.com/v2/redis/databases'))],
  AWS: [
    {
      kind: 'cli', id: 'cli', label: 'Sign in with the AWS CLI', executable: 'aws',
      loginArgs: ['configure', 'sso', 'login'], verifyArgs: ['sts', 'get-caller-identity', '--output', 'text', '--query', 'Arn'],
      installUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
    },
  ],
  'Microsoft Azure': [
    {
      kind: 'cli', id: 'cli', label: 'Sign in with the Azure CLI', executable: 'az',
      loginArgs: ['login'], verifyArgs: ['account', 'show', '--query', 'user.name', '-o', 'tsv'],
      installUrl: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
    },
  ],
  Pulumi: [{ kind: 'cli', id: 'cli', label: 'Sign in with the Pulumi CLI', executable: 'pulumi', loginArgs: ['login'], verifyArgs: ['whoami'], installUrl: 'https://www.pulumi.com/docs/install/' }],
  Kubernetes: [{ kind: 'cli', id: 'cli', label: 'Sign in with kubectl', executable: 'kubectl', loginArgs: ['config', 'view', '--minify'], verifyArgs: ['config', 'current-context'], installUrl: 'https://kubernetes.io/docs/tasks/tools/' }],
  n8n: [apiToken('n8n API key', 'https://docs.n8n.io/api/authentication/', 'n8n_api_…', bearer('https://localhost:5678/api/v1/workflows'))],
  Webhooks: [
    {
      kind: 'token', id: 'endpoint', label: 'Add a webhook endpoint',
      createUrl: 'https://docs.npmjs.com/',
      fields: [{ id: 'secret', kind: 'secret', label: 'Endpoint URL', placeholder: 'https://example.com/hook' }],
    },
  ],
  'REST APIs': [
    {
      kind: 'token', id: 'endpoint', label: 'Add a REST base URL',
      createUrl: 'https://developer.mozilla.org/docs/Web/API/Fetch_API',
      fields: [{ id: 'secret', kind: 'secret', label: 'Base URL', placeholder: 'https://api.example.com/v1' }],
    },
  ],
}

/** Turn a service name into a stable key segment. */
export function serviceId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** The fallback method for a service with no curated recipe. */
function genericToken(name: string): TokenMethod {
  return {
    kind: 'token',
    id: 'token',
    label: 'Connect with an API token',
    createUrl: `https://www.google.com/search?q=${encodeURIComponent(`${name} API token create`)}`,
    fields: [{ id: 'secret', kind: 'secret', label: `${name} API token`, placeholder: 'paste the token' }],
    help: 'KairoForge has no tailored sign-in program for this service yet; the token is stored for the assistant and reported as saved.',
  }
}

/** Every service the card offers, curated recipes first within each category. */
export const CATALOG: readonly ServiceRecipe[] = Object.entries(CATEGORY_NAMES).flatMap(([category, names]) =>
  names.map((name): ServiceRecipe => {
    const curated = RECIPES[name]
    const methods = curated === undefined ? [genericToken(name)] : curated
    const [first, ...rest] = methods
    /* c8 ignore next -- RECIPES entries are written non-empty and genericToken always yields one. */
    if (first === undefined) throw new Error(`connection registry: ${name} has no method`)
    return { id: serviceId(name), name, category, methods: [first, ...rest] }
  }),
)

/** One catalog entry by id. */
export function serviceById(id: string): ServiceRecipe | undefined {
  return CATALOG.find(service => service.id === id)
}
