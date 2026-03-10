interface SessionMapping {
  readonly tmuxSession: string;
  readonly topicId: number;
  readonly projectRoot: string;
  readonly createdAt: Date;
}

interface TmuxSession {
  readonly name: string;
  readonly attached: boolean;
  readonly windows: number;
  readonly created: Date;
}

export type { SessionMapping, TmuxSession };
