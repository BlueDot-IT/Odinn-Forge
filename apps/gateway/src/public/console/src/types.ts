export type ConsoleMessage = {
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
  provider?: string;
  model?: string;
};

export type ConsoleSession = {
  id: string;
  title?: string;
  status?: string;
  projectId?: string;
  updatedAt?: string;
  createdAt?: string;
  messages?: ConsoleMessage[];
  [key: string]: unknown;
};

export type AgentGraphNode = {
  nodeId: string;
  manifestId: string;
  status: string;
  resultRef?: string;
  resultDigest?: string;
  errorCode?: string;
  startedAt?: string;
  settledAt?: string;
};

export type AgentGraphRun = {
  graphRunId: string;
  parentRunId: string;
  requestDigest: string;
  status: string;
  maxConcurrency: number;
  maxRunMs: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  nodes: AgentGraphNode[];
};

export type ConsoleState = {
  status: Record<string, any> | null;
  runs: any[];
  selectedGoalId: string;
  selectedImprovementId: string;
  selectedSessionId: string;
  activeChatId: string;
  messages: ConsoleMessage[];
  sessions: ConsoleSession[];
  modelOverride: string;
  audit: any[];
  auditPage: number;
  auditPagination: { page: number; pages: number };
  browserTabId: string;
  selectedTaskId: string;
  taskPage: number;
  taskPagination: { page: number; pages: number; total: number; from: number; to: number };
  taskSelection: Map<string, boolean>;
  selectedAgentId: string;
  agents: any[];
  agentGraphs: AgentGraphRun[];
  selectedAgentGraphId: string;
  skills: any[];
  selectedSkillId: string;
  projects: any[];
  selectedProjectId: string;
  memories: any[];
  memoryCandidates: any[];
  selectedMemoryId: string;
  memoryTab: string;
  memoryTabInitialized: boolean;
  memoryHealth: any;
  agentManifestDraft: any;
  experimentalRuns: any[];
  experimentalActions: Record<string, any>;
  improvements: any[];
  lastCapabilityToken: string;
  hosted: boolean;
  hostUser: string;
  activityTab: string;
  configFingerprint: string;
  configRestartRequired: boolean;
  config: any;
  activeView: string;
  approvals?: any[];
  tasks?: any[];
  cron?: any[];
  goals?: any[];
};

export type ElementLookup = (id: string) => HTMLElement | null;
