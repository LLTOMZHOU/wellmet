import { ProviderBroken, ProviderUnavailable, type MeetProvider } from './providers.ts';

/**
 * Google Meet rooms through the Meet REST API (scope meetings.space.created).
 * Asks for an open room so guests can join without Tom admitting them; a
 * personal account that refuses that setting gets a default room instead.
 */
export function googleMeet(deps: { fetch: typeof fetch; token: () => Promise<string> }): MeetProvider {
  async function create(body: unknown): Promise<Response> {
    const token = await deps.token();
    try {
      return await deps.fetch('https://meet.googleapis.com/v2/spaces', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderUnavailable('google', `Meet unreachable: ${String(err)}`);
    }
  }

  return {
    async createSpace() {
      let res = await create({ config: { accessType: 'OPEN' } });
      if (res.status === 400) res = await create({});
      if (res.status === 429 || res.status >= 500) throw new ProviderUnavailable('google', `Meet answered ${res.status}.`);
      if (res.status === 401 || res.status === 403) throw new ProviderBroken('google', `meet_${res.status}`);
      if (!res.ok) throw new Error(`Meet create failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const space = (await res.json()) as { meetingUri?: string };
      if (!space.meetingUri) throw new ProviderUnavailable('google', 'Meet returned no meeting link.');
      return { url: space.meetingUri };
    },
  };
}
