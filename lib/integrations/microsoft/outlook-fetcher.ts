import { graphFetch } from './graph-client'

export interface EmailDraft {
  subject: string
  body: {
    contentType: 'Text' | 'HTML'
    content: string
  }
  toRecipients: {
    emailAddress: {
      address: string
    }
  }[]
  ccRecipients?: {
    emailAddress: {
      address: string
    }
  }[]
  bccRecipients?: {
    emailAddress: {
      address: string
    }
  }[]
}

interface OutlookRecipient {
  emailAddress?: { name?: string; address?: string }
}

export interface OutlookEmail {
  id: string
  subject: string | null
  bodyPreview: string | null
  receivedDateTime: string | null
  webLink: string
  conversationId?: string | null
  from?: {
    emailAddress?: {
      name?: string
      address?: string
    }
  }
  toRecipients?: OutlookRecipient[]
  ccRecipients?: OutlookRecipient[]
}

/** $select field list for the canonical header block (P3-5). Shared so the
 *  per-folder query in index.ts and fetchUnreadEmails stay in sync. */
export const OUTLOOK_EMAIL_SELECT =
  'subject,from,toRecipients,ccRecipients,conversationId,receivedDateTime,bodyPreview,webLink'

/** Render a recipient list as "Name <addr>, …" for the header block. */
export function formatRecipients(recipients?: OutlookRecipient[]): string {
  return (recipients ?? [])
    .map((r) => r.emailAddress?.name ?? r.emailAddress?.address)
    .filter(Boolean)
    .join(', ')
}

/**
 * Fetches recent unread emails from Outlook.
 * For background indexing, full bodies are fetched separately via fetchEmailBody.
 */
export async function fetchUnreadEmails(connectionId: string, orgId: string, limit = 20): Promise<OutlookEmail[]> {
  const data = await graphFetch(connectionId, orgId, `/me/messages?$filter=isRead eq false&$top=${limit}&$select=${OUTLOOK_EMAIL_SELECT}`)
  return data.value ?? []
}

/**
 * Fetches the full body of a specific email.
 * Implementation note: caller must discard after use.
 */
export async function fetchEmailBody(connectionId: string, orgId: string, messageId: string): Promise<string> {
  const data = await graphFetch(connectionId, orgId, `/me/messages/${messageId}?$select=body`)
  return data.body.content
}

/**
 * Sends an email on behalf of the user.
 * Requires approval upstream.
 */
export async function sendEmail(connectionId: string, orgId: string, message: EmailDraft) {
  await graphFetch(connectionId, orgId, `/me/sendMail`, {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true }),
  })
}
