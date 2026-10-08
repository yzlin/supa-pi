import type { SlackPermalink } from "./url.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface SlackErrorResponse {
  ok: false;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: {
    messages?: string[];
  };
}

interface SlackOkResponse {
  ok: true;
}

interface RawSlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  permalink?: string;
}

export interface SlackMessage {
  user?: string;
  username?: string;
  text?: string;
  ts: string;
  subtype?: string;
  bot_profile?: {
    name?: string;
  };
  files?: RawSlackFile[];
}

interface RepliesResponse extends SlackOkResponse {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

interface UserInfoResponse extends SlackOkResponse {
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

interface PostMessageResponse extends SlackOkResponse {
  channel?: string;
  ts?: string;
}

export interface SlackThread {
  messages: SlackMessage[];
  users: Map<string, string>;
  truncatedByMessageLimit: boolean;
}

export interface SlackIdentity {
  team?: string;
  teamId?: string;
  workspaceUrl?: string;
  user?: string;
  userId?: string;
}

export interface PostedSlackMessage {
  channel: string;
  ts: string;
}

function compactScopes(scopes: string | undefined): string | undefined {
  if (!scopes) {
    return undefined;
  }
  const values = scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return values.length > 0 ? values.join(", ") : undefined;
}

export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  readonly needed?: string;
  readonly provided?: string;
  readonly diagnostics?: string[];

  constructor(
    method: string,
    code: string,
    needed?: string,
    provided?: string,
    diagnostics?: string[],
  ) {
    const details = [
      needed ? `needed: ${compactScopes(needed)}` : undefined,
      diagnostics?.length ? diagnostics.join("; ") : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    super(`Slack ${method} failed: ${code}${details ? ` (${details})` : ""}`);
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
    this.needed = needed;
    this.provided = provided;
    this.diagnostics = diagnostics;
  }
}

export class SlackUserClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #users = new Map<string, string>();

  constructor(token: string, fetchImpl: FetchLike = globalThis.fetch) {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new Error("SLACK_USER_TOKEN is empty.");
    }

    this.#token = normalizedToken;
    this.#fetch = fetchImpl;
  }

  async #request(
    method: string,
    body: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        form.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal,
        redirect: "error",
      });
    } catch {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new Error(`Slack ${method} request failed.`);
    }

    if (!response.ok) {
      throw new Error(`Slack ${method} returned HTTP ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error(`Slack ${method} returned invalid JSON.`);
    }
  }

  async #call<T extends SlackOkResponse>(
    method: string,
    body: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    const payload = (await this.#request(method, body, signal)) as
      | SlackOkResponse
      | SlackErrorResponse;
    if (payload.ok === false) {
      const redact = (value: unknown): string | undefined =>
        typeof value === "string"
          ? value.replaceAll(this.#token, "[redacted]")
          : undefined;
      const messages: unknown = payload.response_metadata?.messages;
      throw new SlackApiError(
        method,
        redact(payload.error) ?? "unknown_error",
        redact(payload.needed),
        redact(payload.provided),
        Array.isArray(messages)
          ? messages
              .map(redact)
              .filter((value): value is string => value !== undefined)
          : undefined,
      );
    }

    return payload as T;
  }

  async authTest(signal?: AbortSignal): Promise<SlackIdentity> {
    const response = await this.#request("auth.test", {}, signal);
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response) ||
      response.ok !== true
    ) {
      throw new Error("Slack auth.test validation failed.");
    }
    const field = (name: string): string | undefined => {
      if (!(name in response)) {
        return undefined;
      }
      const value: unknown = Reflect.get(response, name);
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.includes(this.#token)
      ) {
        throw new Error("Slack auth.test returned an invalid identity.");
      }
      return value;
    };
    const identity = {
      team: field("team"),
      teamId: field("team_id"),
      workspaceUrl: field("url"),
      user: field("user"),
      userId: field("user_id"),
    };
    if (
      !(identity.user || identity.userId) ||
      !(identity.team || identity.teamId || identity.workspaceUrl)
    ) {
      throw new Error("Slack auth.test returned an incomplete identity.");
    }
    return identity;
  }

  async readThread(
    target: SlackPermalink,
    maxMessages: number,
    signal?: AbortSignal,
  ): Promise<SlackThread> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    let moreAvailable = false;

    do {
      const remaining = maxMessages - messages.length;
      const response = await this.#call<RepliesResponse>(
        "conversations.replies",
        {
          channel: target.channelId,
          ts: target.threadTs,
          limit: Math.min(remaining, 200),
          cursor,
        },
        signal,
      );

      messages.push(...(response.messages ?? []).slice(0, remaining));
      cursor = response.response_metadata?.next_cursor?.trim() || undefined;
      moreAvailable = Boolean(response.has_more || cursor);
    } while (cursor && messages.length < maxMessages);

    await this.#hydrateUsers(messages, signal);

    return {
      messages,
      users: new Map(this.#users),
      truncatedByMessageLimit: moreAvailable && messages.length >= maxMessages,
    };
  }

  async postReply(
    target: SlackPermalink,
    text: string,
    signal?: AbortSignal,
  ): Promise<PostedSlackMessage> {
    const response = await this.#call<PostMessageResponse>(
      "chat.postMessage",
      {
        channel: target.channelId,
        thread_ts: target.threadTs,
        text,
      },
      signal,
    );

    if (!response.channel || !response.ts) {
      throw new Error(
        "Slack chat.postMessage succeeded without returning a channel and timestamp.",
      );
    }

    return {
      channel: response.channel,
      ts: response.ts,
    };
  }

  async #hydrateUsers(
    messages: SlackMessage[],
    signal?: AbortSignal,
  ): Promise<void> {
    const userIds = new Set<string>();

    for (const message of messages) {
      if (message.user) {
        userIds.add(message.user);
      }
      for (const match of message.text?.matchAll(/<@([A-Z0-9]+)>/g) ?? []) {
        if (match[1]) {
          userIds.add(match[1]);
        }
      }
    }

    for (const userId of userIds) {
      if (this.#users.has(userId)) {
        continue;
      }

      try {
        const response = await this.#call<UserInfoResponse>(
          "users.info",
          { user: userId },
          signal,
        );
        const profile = response.user?.profile;
        const displayName =
          profile?.display_name?.trim() ||
          profile?.real_name?.trim() ||
          response.user?.real_name?.trim() ||
          response.user?.name?.trim() ||
          userId;
        this.#users.set(userId, displayName);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        this.#users.set(userId, userId);
      }
    }
  }
}
