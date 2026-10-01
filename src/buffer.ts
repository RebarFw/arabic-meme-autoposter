import { AppError, type Channel, type Env } from './types';
import { limitedBytes } from './security';

export interface BufferPost { id: string; status: string; schedulingType: string; }
export const CREATE_POST = `mutation PublishReel($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status schedulingType } }
    ... on MutationError { message }
  }
}`;

export class BufferClient {
  constructor(private env: Env) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}, mutation = false): Promise<T> {
    if (!this.env.BUFFER_API_KEY) throw new AppError('missing_buffer_api_key');
    let response: Response;
    try {
      response = await fetch('https://api.buffer.com', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${this.env.BUFFER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new AppError(mutation ? 'buffer_create_unknown' : 'buffer_network_error', !mutation); }
    if (!response.ok) {
      await response.body?.cancel();
      // Even 5xx responses can follow a successful mutation. Never retry a create.
      throw new AppError(mutation ? 'buffer_create_unknown' : `buffer_http_${response.status}`, !mutation && (response.status === 429 || response.status >= 500));
    }
    let result: { data?: T; errors?: unknown[] };
    try { result = JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 512_000))); }
    catch { throw new AppError(mutation ? 'buffer_create_unknown' : 'buffer_invalid_response', !mutation); }
    if (result.errors?.length || !result.data) throw new AppError(mutation ? 'buffer_create_unknown' : 'buffer_query_error');
    return result.data;
  }

  async discoverChannels(): Promise<[Channel, Channel]> {
    const account = await this.query<{ account: { organizations: { id: string }[] } }>('query { account { organizations { id } } }');
    const candidates: Channel[] = [];
    for (const org of account.account.organizations.slice(0, 10)) {
      const result = await this.query<{ channels: Channel[] }>(`query Channels($input: ChannelsInput!) {
        channels(input: $input) { id name service serviceId organizationId isDisconnected isLocked metadata { ... on TiktokMetadata { defaultToReminders } } }
      }`, { input: { organizationId: org.id } });
      candidates.push(...result.channels.filter(c => ['instagram','tiktok'].includes(c.service)));
    }
    const instagram = candidates.filter(c => c.service === 'instagram');
    const tiktok = candidates.filter(c => c.service === 'tiktok');
    if (instagram.length !== 1 || tiktok.length !== 1) throw new AppError('buffer_channels_ambiguous');
    const pair: [Channel, Channel] = [instagram[0]!, tiktok[0]!];
    if (pair.some(c => c.isDisconnected || c.isLocked || c.metadata?.defaultToReminders)) throw new AppError('buffer_channel_not_automatic');
    const expected = [this.env.EXPECTED_INSTAGRAM_CHANNEL_ID, this.env.EXPECTED_TIKTOK_CHANNEL_ID, this.env.EXPECTED_INSTAGRAM_USERNAME, this.env.EXPECTED_TIKTOK_USERNAME];
    if (expected.some(Boolean)) {
      if (!expected.every(Boolean)) throw new AppError('buffer_channel_selection_incomplete');
      if (pair[0].id !== expected[0] || pair[1].id !== expected[1] || pair[0].name.toLowerCase().replace(/^@/, '') !== expected[2]!.toLowerCase().replace(/^@/, '') || pair[1].name.toLowerCase().replace(/^@/, '') !== expected[3]!.toLowerCase().replace(/^@/, '')) throw new AppError('buffer_channel_identity_mismatch');
    }
    return pair;
  }

  async publish(channelId: string, service: string, caption: string, mediaUrl: string): Promise<BufferPost> {
    const expected = service === 'instagram' ? this.env.EXPECTED_INSTAGRAM_CHANNEL_ID : service === 'tiktok' ? this.env.EXPECTED_TIKTOK_CHANNEL_ID : undefined;
    if (!['instagram', 'tiktok'].includes(service) || expected && channelId !== expected) throw new AppError('buffer_channel_identity_mismatch');
    const input = {
      channelId, text: caption, schedulingType: 'automatic', mode: 'shareNow',
      needsApproval: false, saveToDraft: false, source: 'arabic-meme-autoposter',
      assets: [{ video: { url: mediaUrl } }],
      ...(service === 'instagram' ? { metadata: { instagram: { type: 'reel', shouldShareToFeed: true } } } : {}),
    };
    const result = await this.query<{ createPost: { __typename: string; post?: BufferPost } }>(CREATE_POST, { input }, true);
    if (['InvalidInputError','UnauthorizedError','NotFoundError','LimitReachedError'].includes(result.createPost.__typename)) throw new AppError('buffer_create_rejected');
    if (result.createPost.__typename !== 'PostActionSuccess') throw new AppError('buffer_create_unknown');
    const post = result.createPost.post;
    if (!post?.id || !post.status) throw new AppError('buffer_create_unknown');
    return post;
  }

  async post(id: string): Promise<BufferPost> {
    const result = await this.query<{ post: BufferPost }>('query Post($input: PostInput!) { post(input: $input) { id status schedulingType } }', { input: { id } });
    if (!result.post?.id || !result.post.status) throw new AppError('buffer_invalid_post');
    return result.post;
  }
}
