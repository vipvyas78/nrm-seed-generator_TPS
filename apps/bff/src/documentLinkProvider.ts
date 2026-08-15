/**
 * Resolves a tender document's filename to a shareable link at whatever third-party
 * storage actually holds the file. TPS itself never stores document bytes — only
 * doc_type/filename/page_count, read from the parent take-off platform's schema — so this
 * is the seam between "we know a document exists" and "we can point someone at it".
 */
export interface DocumentLinkProvider {
  linkFor(filename: string): Promise<string | null>;
}

interface DropboxMetadata {
  '.tag': string;
  path_display?: string;
}

interface DropboxSearchResult {
  matches: Array<{ metadata: { metadata: DropboxMetadata } }>;
}

interface DropboxSharedLink {
  url: string;
}

interface DropboxSharedLinksResult {
  links: DropboxSharedLink[];
}

/**
 * Finds a file by name anywhere in the Dropbox account behind the given access token, and
 * reuses or creates a shared link for it. Matches on filename only — if two projects ever
 * reuse the same document name, this returns whichever Dropbox's search ranks first. Good
 * enough while documents are organised by hand; revisit with a path/session convention if
 * that becomes a real collision.
 */
export class DropboxDocumentLinkProvider implements DocumentLinkProvider {
  constructor(private readonly accessToken: string) {}

  async linkFor(filename: string): Promise<string | null> {
    try {
      const path = await this.findPath(filename);
      if (!path) return null;
      return (await this.existingLink(path)) ?? (await this.createLink(path));
    } catch {
      return null;
    }
  }

  private async api<T>(route: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.dropboxapi.com/2/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Dropbox ${route} failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  private async findPath(filename: string): Promise<string | null> {
    const result = await this.api<DropboxSearchResult>('files/search_v2', {
      query: filename,
      options: { max_results: 1, file_status: 'active', filename_only: true }
    });
    const match = result.matches[0]?.metadata.metadata;
    return match?.['.tag'] === 'file' ? (match.path_display ?? null) : null;
  }

  private async existingLink(path: string): Promise<string | null> {
    const result = await this.api<DropboxSharedLinksResult>('sharing/list_shared_links', {
      path,
      direct_only: true
    });
    return result.links[0]?.url ?? null;
  }

  private async createLink(path: string): Promise<string> {
    const result = await this.api<DropboxSharedLink>('sharing/create_shared_link_with_settings', { path });
    return result.url;
  }
}
