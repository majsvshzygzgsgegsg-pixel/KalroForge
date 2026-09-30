/** KairoForge connection catalog shown from General Settings. */
import { useMemo, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ConnectionsCard.module.css'

interface ConnectionService {
  readonly name: string
  readonly category: string
}

const SERVICES: readonly ConnectionService[] = [
  ...['GitHub', 'GitLab', 'Bitbucket', 'Azure DevOps', 'Gitea', 'SourceForge', 'Codeberg', 'Linear', 'Jira', 'Trello', 'Asana', 'ClickUp', 'Monday.com', 'Notion', 'Coda', 'Airtable', 'Confluence', 'Shortcut', 'Height', 'Basecamp', 'YouTrack', 'Sentry', 'Datadog', 'New Relic', 'Grafana', 'PagerDuty', 'Opsgenie', 'Statuspage', 'LaunchDarkly', 'PostHog'].map(name => ({ name, category: 'Code & work' })),
  ...['Gmail', 'Google Calendar', 'Google Contacts', 'Google Drive', 'Google Docs', 'Google Sheets', 'Google Slides', 'Google Forms', 'Google Tasks', 'Google Keep', 'Google Meet', 'Outlook Mail', 'Outlook Calendar', 'Microsoft OneDrive', 'Microsoft SharePoint', 'Microsoft Teams', 'Microsoft To Do', 'Microsoft Planner', 'Exchange', 'Yahoo Mail', 'iCloud Mail', 'Fastmail', 'Proton Mail', 'Zoho Mail', 'Superhuman', 'Calendly', 'Cal.com', 'Doodle', 'Acuity Scheduling', 'SavvyCal'].map(name => ({ name, category: 'Email & calendar' })),
  ...['Slack', 'Discord', 'Telegram', 'WhatsApp Business', 'Signal', 'Messenger', 'Instagram', 'Facebook Pages', 'Facebook Groups', 'X / Twitter', 'LinkedIn', 'LinkedIn Pages', 'Reddit', 'YouTube', 'TikTok', 'Pinterest', 'Snapchat', 'Threads', 'Mastodon', 'Bluesky', 'Twitch', 'Zoom', 'Webex', 'Google Chat', 'Mattermost', 'Rocket.Chat', 'Twilio', 'SendGrid', 'Mailchimp', 'Constant Contact'].map(name => ({ name, category: 'Chat & social' })),
  ...['Dropbox', 'Box', 'MEGA', 'pCloud', 'Backblaze B2', 'Wasabi', 'Amazon S3', 'Google Cloud Storage', 'Azure Blob Storage', 'Cloudflare R2', 'DigitalOcean Spaces', 'Firebase Storage', 'Supabase Storage', 'Imgur', 'Cloudinary', 'ImageKit', 'Filestack', 'DocuSign', 'Dropbox Sign', 'PandaDoc', 'Adobe Acrobat Sign', 'Canva', 'Figma', 'FigJam', 'Miro', 'Mural', 'Lucidchart', 'Whimsical', 'Excalidraw', 'Draw.io'].map(name => ({ name, category: 'Files & design' })),
  ...['Stripe', 'PayPal', 'Square', 'Shopify', 'WooCommerce', 'BigCommerce', 'Etsy', 'eBay', 'Amazon Seller Central', 'Walmart Marketplace', 'Gumroad', 'Lemon Squeezy', 'Paddle', 'Chargebee', 'Recurly', 'QuickBooks', 'Xero', 'FreshBooks', 'Wave', 'Plaid', 'Wise', 'Mercury', 'Brex', 'Ramp', 'Expensify', 'Bill.com', 'Netsuite', 'Sage', 'Odoo', 'SAP'].map(name => ({ name, category: 'Sales & finance' })),
  ...['Salesforce', 'HubSpot', 'Pipedrive', 'Zendesk', 'Intercom', 'Freshdesk', 'Help Scout', 'Front', 'Kustomer', 'Gorgias', 'ServiceNow', 'Dynamics 365', 'Zoho CRM', 'Close', 'Copper', 'Keap', 'ActiveCampaign', 'Customer.io', 'Klaviyo', 'Braze', 'Iterable', 'Segment', 'Amplitude', 'Mixpanel', 'Heap', 'Hotjar', 'FullStory', 'Google Analytics', 'Google Ads', 'Meta Ads'].map(name => ({ name, category: 'CRM & marketing' })),
  ...['OpenAI', 'Anthropic', 'Google Gemini', 'Mistral AI', 'Cohere', 'DeepSeek', 'Groq', 'Together AI', 'Replicate', 'Hugging Face', 'Perplexity', 'ElevenLabs', 'AssemblyAI', 'Deepgram', 'Pinecone', 'Weaviate', 'Qdrant', 'Milvus', 'Chroma', 'LangSmith', 'Weights & Biases', 'Comet', 'Modal', 'RunPod', 'Baseten', 'Anyscale', 'Fal.ai', 'Stability AI', 'Leonardo AI', 'Midjourney'].map(name => ({ name, category: 'AI & data' })),
  ...['AWS', 'Google Cloud', 'Microsoft Azure', 'Vercel', 'Netlify', 'Cloudflare', 'Render', 'Railway', 'Fly.io', 'Heroku', 'DigitalOcean', 'Linode', 'Vultr', 'Kubernetes', 'Docker Hub', 'GitHub Actions', 'CircleCI', 'Travis CI', 'Jenkins', 'Buildkite', 'Terraform Cloud', 'Pulumi', 'MongoDB Atlas', 'Supabase', 'Neon', 'PlanetScale', 'Redis Cloud', 'Upstash', 'Elastic Cloud', 'Snowflake'].map(name => ({ name, category: 'Cloud & devops' })),
  ...['Zapier', 'Make', 'n8n', 'IFTTT', 'Workato', 'Tray.io', 'Pabbly Connect', 'Retool', 'Appsmith', 'Budibase', 'Typeform', 'Jotform', 'Tally', 'Fillout', 'Paperform', 'Webflow', 'Wix', 'Squarespace', 'WordPress', 'Ghost', 'Contentful', 'Sanity', 'Strapi', 'Prismic', 'Shopify CMS', 'RSS', 'Webhooks', 'GraphQL APIs', 'REST APIs', 'MCP Servers'].map(name => ({ name, category: 'Automation & web' })),
] as const

const CATEGORIES = ['All', ...Array.from(new Set(SERVICES.map(service => service.category)))] as const

/**
 * Render a searchable catalog of services KairoForge can be taught to connect.
 * @param props - settings runtime and localized copy.
 * @returns the General Settings connections row.
 */
export function ConnectionsCard({ t }: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [selected, setSelected] = useState<ConnectionService | null>(null)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return SERVICES.filter(service =>
      (category === 'All' || service.category === category)
      && (needle === '' || service.name.toLowerCase().includes(needle) || service.category.toLowerCase().includes(needle)))
  }, [category, query])
  return <div className={css.row}>
    <div className={css.header}>
      <div>
        <div className={css.title}>{t('connections.title')}</div>
        <div className={css.description}>{t('connections.description')}</div>
      </div>
      <div className={css.badge}>{t('connections.count', { count: SERVICES.length })}</div>
    </div>
    <div className={css.toolbar}>
      <input className={css.search} value={query} type="search" placeholder={t('connections.search')}
        aria-label={t('connections.search')} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      <select className={css.select} value={category} aria-label={t('connections.category')}
        onChange={(event) => { setCategory(event.currentTarget.value) }}>
        {CATEGORIES.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
    {visible.length === 0 ? <div className={css.empty}>{t('connections.empty')}</div> : <div className={css.grid}>
      {visible.map(service => <div className={css.card} key={`${service.category}:${service.name}`}>
        <div className={css.service}>
          <div className={css.name} title={service.name}>{service.name}</div>
          <div className={css.category}>{service.category}</div>
        </div>
        <button type="button" className={css.connect} onClick={() => { setSelected(service) }}>
          {t('connections.connect')}
        </button>
      </div>)}
    </div>}
    <div className={css.notice} role={selected === null ? undefined : 'status'}>
      {selected === null ? t('connections.notice') : t('connections.selected', { service: selected.name })}
    </div>
    <Modal
      open={selected !== null}
      onClose={() => { setSelected(null) }}
      title={selected === null ? t('connections.setupTitleFallback') : t('connections.setupTitle', { service: selected.name })}
      {...selected !== null && { description: t('connections.setupDescription', { service: selected.name }) }}
      closeLabel={t('close')}
    >
      {selected !== null && (
        <div className={css.modalBody}>
          <div className={css.setupHero}>
            <div className={css.setupMark}>{selected.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <div className={css.setupName}>{selected.name}</div>
              <div className={css.setupCategory}>{selected.category}</div>
            </div>
          </div>
          <ol className={css.setupSteps}>
            <li>{t('connections.setupStepAuth', { service: selected.name })}</li>
            <li>{t('connections.setupStepCredentials')}</li>
            <li>{t('connections.setupStepTools')}</li>
          </ol>
          <div className={css.setupNotice}>{t('connections.setupNotice')}</div>
        </div>
      )}
    </Modal>
  </div>
}

export { SERVICES as CONNECTION_SERVICES }
