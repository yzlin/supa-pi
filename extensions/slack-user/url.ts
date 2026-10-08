export interface SlackPermalink {
  originalUrl: string;
  workspaceUrl: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

const SLACK_TIMESTAMP = /^\d+\.\d{1,6}$/;

function timestampFromPath(digits: string): string {
  if (digits.length <= 6) {
    throw new Error("Slack permalink has an invalid message timestamp.");
  }

  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

export function parseSlackPermalink(input: string): SlackPermalink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Expected a valid Slack message permalink.");
  }

  if (
    url.protocol !== "https:" ||
    (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com"))
  ) {
    throw new Error("Expected an HTTPS permalink hosted on slack.com.");
  }

  const match = url.pathname.match(
    /^\/archives\/([A-Z][A-Z0-9]+)\/p(\d+)\/?$/i,
  );
  if (!match) {
    throw new Error(
      "Expected a Slack message permalink containing /archives/<channel>/p<timestamp>.",
    );
  }

  const channelId = match[1].toUpperCase();
  const messageTs = timestampFromPath(match[2]);
  const requestedThreadTs = url.searchParams.get("thread_ts");

  if (requestedThreadTs !== null && !SLACK_TIMESTAMP.test(requestedThreadTs)) {
    throw new Error("Slack permalink has an invalid thread_ts parameter.");
  }

  return {
    originalUrl: url.toString(),
    workspaceUrl: `${url.protocol}//${url.host}`,
    channelId,
    messageTs,
    threadTs: requestedThreadTs ?? messageTs,
  };
}

export function buildSlackReplyPermalink(
  target: SlackPermalink,
  messageTs: string,
): string {
  if (!SLACK_TIMESTAMP.test(messageTs)) {
    throw new Error("Slack returned an invalid message timestamp.");
  }

  const permalink = new URL(
    `/archives/${target.channelId}/p${messageTs.replace(".", "")}`,
    target.workspaceUrl,
  );
  permalink.searchParams.set("thread_ts", target.threadTs);
  permalink.searchParams.set("cid", target.channelId);
  return permalink.toString();
}
