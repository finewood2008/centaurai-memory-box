export type WanxConnectionState = 'ready' | 'recovering';

export type WanxResourceBinding =
  | {kind: 'expert'; resourceId: string; instanceId: string; version: string}
  | {kind: 'skill-package'; resourceId: string; packageId: string; version: string};

export interface WanxHostContext {
  protocolVersion?: number;
  accountId?: string;
  clientId?: string;
  boxId: string;
  user: {id: number; [key: string]: unknown};
  connection: WanxConnectionState;
  applicationId?: string;
  artifactId?: string;
  resourceBindings?: WanxResourceBinding[];
}

export interface WanxSpaceEntry {
  space_id: string;
  id: string;
  parent: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  modified: number;
  trashed: number | null;
  digest: string | null;
  version: number;
  previous_size: number;
  previous_digest: string | null;
}

export interface WanxSpaceListing {
  space_id: string;
  root: string;
  items: WanxSpaceEntry[];
  breadcrumbs: {id: string; name: string}[];
  parent: string;
}

export interface WanxUploadStatus {
  id: string;
  parent: string;
  name: string;
  size: number;
  offset: number;
  state: string;
  modified: number;
}

export interface WanxApiError {
  detail?: {code: string; message?: string} | string;
  code?: string;
  message?: string;
}

export interface WanxDialogueModel {
  id: string;
  source?: string;
  name?: string;
  provider?: string;
  input_units?: string;
  output_units?: string;
  max_output_tokens?: number;
  max_input_bytes?: number;
}

export type WanxContractStatus = 'open' | 'ready-for-acceptance' | 'contract-only' | 'inventory-only' | 'forbidden';

export interface WanxAgent {
  agent_id: string;
  name: string;
  description?: string | null;
  default_model?: string | null;
  state?: string;
  application_id?: 'wanx' | string;
  user_id?: number | null;
  [key: string]: unknown;
}

export interface WanxAgentStatus {
  state: string;
  last_error?: string | null;
  channels: Array<{id: string; kind: string; name: string}>;
  cron_jobs: Array<{id: string; prompt: string; trigger: unknown}>;
  memory_maintenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WanxThread {
  thread_id: string;
  title?: string | null;
  channel_type: string;
  session_key: string;
  last_active?: number | null;
  created_at?: number | null;
  is_active: boolean;
  has_messages: boolean;
  pinned: boolean;
  model_ref?: string | null;
  reasoning_mode?: string | null;
  reasoning_effort?: string | null;
  conversation_mode: 'ask' | 'plan' | 'craft';
  pending_plan_path?: string | null;
  hitl_policy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WanxThreadHistory {
  thread_id: string;
  model_ref?: string | null;
  messages: Array<Record<string, unknown>>;
  has_more: boolean;
  limit: number;
  offset: number;
  next_cursor?: string | null;
  history_loading: boolean;
  history_status: string;
  history_retry_after_ms: number;
  turn_active: boolean;
  hitl_pending?: Record<string, unknown> | null;
  conversation_mode: 'ask' | 'plan' | 'craft';
  pending_plan_path?: string | null;
  hitl_policy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WanxDialogueQuota {
  source: 'wanx_pool' | 'platform_gateway' | string;
  remaining: number | null;
  pending: number;
  billing: string;
}

export type WanxDialogueAnswerStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';

export interface WanxDialogueAnswer {
  id: string;
  generation_id: string;
  model: string;
  name: string;
  text: string;
  status: WanxDialogueAnswerStatus;
  error: string | null;
  usage: Record<string, unknown> | null;
  elapsed_ms: number | null;
  accounting: Record<string, unknown> | null;
}

export interface WanxDialogueGroup {
  id: string;
  prompt: string;
  parent_answer: string | null;
  answers: WanxDialogueAnswer[];
}

export interface WanxDialogueSession {
  id: string;
  title: string;
  revision: number;
  groups: WanxDialogueGroup[];
}

export interface WanxDialogueSessionListItem {
  session_id: string;
  title: string;
  updated_at: number;
}

export interface WanxDialogueSessionList {
  sessions: WanxDialogueSessionListItem[];
}

export interface WanxDialogueEvent {
  type: 'snapshot';
  session: WanxDialogueSession;
}

export interface WanxDialogueQuestion {
  request_id: string;
  prompt: string;
  models: string[];
}

export interface WanxDialogueOperation {
  request_id: string;
}

export interface WanxDialogueAddModels extends WanxDialogueOperation {
  models: string[];
}

export interface WanxDialogueFollowUp extends WanxDialogueOperation {
  prompt: string;
}

export interface WanxExpertSummary {
  id: string;
  label: {zh: string; en: string};
  description: {zh: string; en: string};
  welcome_message: {zh: string; en: string};
  icon_name?: string | null;
  icon_url?: string | null;
  color?: string | null;
  quick_prompts: WanxQuickPrompt[];
  task_examples?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WanxQuickPrompt {
  title: {zh: string; en: string};
  description: {zh: string; en: string};
  prompt: {zh: string; en: string};
  color: string;
  icon_name?: string | null;
}

export interface WanxExpertDetail extends WanxExpertSummary {
  files: string[];
  prompt_files: string[];
  file_contents: Record<string, string>;
}

export interface WanxExpertCreateRequest {
  name: string;
  description?: string | null;
  providers?: string[] | null;
  default_model?: string | null;
  agent_id?: string | null;
  color?: string | null;
  welcome_message?: string | null;
  enable_trajectory?: boolean;
  skill_package_ids?: string[] | null;
  knowledge_base_ids?: string[] | null;
  mcp_servers?: string[] | null;
  backend?: Record<string, unknown> | null;
  max_iters?: number | null;
  max_input_length?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  file_overrides?: Array<Record<string, unknown>> | null;
  omit_files?: string[] | null;
  quick_prompts?: WanxQuickPrompt[] | null;
}

export interface WanxMemoryItem {
  id?: string;
  entity_id?: string | null;
  candidate_id?: string | null;
  assertion?: string;
  verbatim_quote?: string | null;
  quote_event_id?: string | null;
  kind?: string | null;
  candidate_type?: string | null;
  status?: string | null;
  confidence?: string | null;
  importance?: string | null;
  created_at?: string | number | null;
  occurred_at?: string | number | null;
  [key: string]: unknown;
}

export interface WanxMemoryPage {
  items: WanxMemoryItem[];
  total?: number;
  offset?: number;
  limit?: number;
}

export interface WanxMemoryMutation {
  status?: 'created' | 'replaced' | 'deprecated' | 'promoted' | 'rejected' | string;
  atom?: WanxMemoryItem;
  old_atom_id?: string;
  created_entity?: boolean;
  [key: string]: unknown;
}

export interface WanxMemoryExtractConfig {
  memory_enabled: boolean;
  extract_on_session_end: boolean;
  extract_trigger_mode: 'idle' | 'interval';
  extract_idle_seconds: number;
  extract_interval_seconds: number;
  aux_model: string | null;
}

export type WanxPermission =
  | 'models.read'
  | 'agents.read'
  | 'threads.read'
  | 'threads.create'
  | 'threads.stream'
  | 'threads.hitl'
  | 'dialogue.models.read'
  | 'dialogue.sessions.read'
  | 'dialogue.sessions.create'
  | 'dialogue.sessions.mutate'
  | 'dialogue.sessions.stream'
  | 'experts.read'
  | 'experts.instantiate'
  | 'agents.lifecycle'
  | 'memory.read'
  | 'memory.write'
  | 'memory.config.read'
  | 'memory.config.write';
