import {
  formatPersonaVisualCastLine,
  type ClientAction,
  type CreateSessionRequest,
  type Participant,
  type ParticipantId,
  type TableState,
} from "@llm-table/shared";
import {
  continueToNextHand,
  isAwaitingNextHand,
  isPokerState,
  withPokerChatWindow,
} from "@llm-table/poker";
import {
  buildInitialRpgState,
  isRpgState,
  maybeRefreshTranscriptSummary,
  normalizeRpgState,
  resolveAdventureSeed,
  type RpgAdvanceState,
  type RpgPreparationProgress,
} from "@llm-table/rpg";
import {
  chatCompletion,
  generateImage,
  type ChatCompletionProgress,
  type ImageGenerationProgress,
} from "./openrouter";
import { getModule } from "./modules";
import {
  getActiveSessionId,
  getStoredSession,
  putStoredSession,
  setActiveSessionId,
  type StoredSession,
} from "./storage";

const TRANSCRIPT_WINDOW = 40;
const DEFAULT_HUMAN_TIMEOUT_MS = 20_000;
const PREPARE_PROGRESS_THROTTLE_MS = 200;

interface RpgPrefetchSlot {
  generation: number;
  speakerId: ParticipantId;
  promise: Promise<ClientAction>;
  action: ClientAction | null;
  error: string | null;
}

interface RuntimeSession {
  state: TableState;
  apiKey: string;
  humanParticipantId: ParticipantId | null;
  turnGeneration: number;
  waitingForHuman: ParticipantId | null;
  rpgPrefetch: RpgPrefetchSlot | null;
  /** Coalesces concurrent Next presses onto one in-flight advance. */
  rpgAdvanceInFlight: Promise<void> | null;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatChatProgressDetail(progress: ChatCompletionProgress): string {
  const parts: string[] = [];
  if (progress.receivedChars > 0) {
    parts.push(`${progress.receivedChars.toLocaleString()} chars`);
  }
  if (progress.receivedBytes > 0) {
    parts.push(`${formatByteCount(progress.receivedBytes)} received`);
  }
  if (progress.completionTokens != null) {
    parts.push(`${progress.completionTokens.toLocaleString()} completion tokens`);
  } else if (progress.totalTokens != null) {
    parts.push(`${progress.totalTokens.toLocaleString()} tokens`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Waiting for first tokens…";
}

function formatImageProgressDetail(progress: ImageGenerationProgress): string {
  const parts: string[] = [];
  if (progress.partialFrames != null && progress.partialFrames > 0) {
    parts.push(`${progress.partialFrames} preview frame${progress.partialFrames === 1 ? "" : "s"}`);
  }
  if (progress.receivedBytes > 0) {
    parts.push(`${formatByteCount(progress.receivedBytes)} received`);
  }
  if (progress.done) {
    parts.push("done");
  }
  return parts.length > 0 ? parts.join(" · ") : "Waiting for image response…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findParticipant(state: TableState, id: ParticipantId): Participant {
  const p = state.participants.find((x) => x.id === id);
  if (!p) {
    throw new Error(`Unknown participant: ${id}`);
  }
  return p;
}

function withRpgAdvance(state: TableState, advance: RpgAdvanceState): TableState {
  if (!isRpgState(state.moduleState)) {
    return state;
  }
  const rpg = normalizeRpgState(state.moduleState);
  return {
    ...state,
    moduleState: {
      ...rpg,
      advance,
    },
  };
}

function buildSessionFromRequest(request: CreateSessionRequest): RuntimeSession {
  if (!request.apiKey.trim()) {
    throw new Error("OpenRouter API key is required");
  }
  if (!request.coordinatorModel.trim()) {
    throw new Error("Coordinator model is required");
  }
  if (request.personas.length < 2) {
    throw new Error("At least 2 LLM personas are required");
  }

  for (const persona of request.personas) {
    if (!persona.displayName.trim()) {
      throw new Error("Each persona needs a display name");
    }
    if (!persona.systemPrompt.trim()) {
      throw new Error(`Persona "${persona.displayName}" needs a definition`);
    }
    if (!persona.model.trim()) {
      throw new Error(`Persona "${persona.displayName}" needs a model`);
    }
  }

  getModule(request.moduleId);

  const sessionId = crypto.randomUUID();
  const isRpg = request.moduleId === "rpg";
  const adventureSeed = isRpg
    ? resolveAdventureSeed({
        adventureSeedId: request.adventureSeedId,
        adventureSeed: request.adventureSeed,
      })
    : null;

  const gmPersonaId = isRpg ? request.gmPersonaId?.trim() : undefined;
  if (isRpg) {
    if (!gmPersonaId) {
      throw new Error("RPG table requires a GM persona");
    }
    const gmDraft = request.personas.find((p) => p.id.trim() === gmPersonaId);
    if (!gmDraft) {
      throw new Error("GM persona must be one of the invited personas");
    }
  }

  const participants: Participant[] = request.personas.map((p, index) => {
    const id = p.id.trim() || crypto.randomUUID();
    const isGm = isRpg && id === gmPersonaId;
    return {
      id,
      kind: "llm" as const,
      displayName: p.displayName.trim(),
      persona: {
        systemPrompt: p.systemPrompt.trim(),
        model: p.model.trim(),
        ...(p.portraitDataUrl?.trim()
          ? { portraitDataUrl: p.portraitDataUrl.trim() }
          : {}),
      },
      seatIndex: index,
      ...(isRpg ? { tableRole: (isGm ? "gm" : "pc") as "gm" | "pc" } : {}),
    };
  });

  let humanParticipantId: ParticipantId | null = null;
  const humanName = request.humanName?.trim();
  if (humanName) {
    humanParticipantId = crypto.randomUUID();
    participants.push({
      id: humanParticipantId,
      kind: "human",
      displayName: humanName,
      seatIndex: participants.length,
      ...(isRpg ? { tableRole: "pc" as const } : {}),
    });
  }

  if (isRpg) {
    const pcs = participants.filter((p) => p.tableRole !== "gm");
    if (pcs.length < 1) {
      throw new Error("RPG table needs at least one PC besides the GM");
    }
  }

  const moduleState = isRpg
    ? buildInitialRpgState(participants, adventureSeed!)
    : {};

  const state: TableState = {
    sessionId,
    moduleId: request.moduleId,
    participants,
    messages: [],
    activeSpeakerId: null,
    phase: "lobby",
    moduleState,
    coordinatorModel: request.coordinatorModel.trim(),
    ...(request.imageModel?.trim() ? { imageModel: request.imageModel.trim() } : {}),
    ...(isRpg ? { gmImagesEnabled: request.gmImagesEnabled === true } : {}),
    error: null,
    statusMessage: isRpg
      ? `${adventureSeed!.title} — lobby`
      : "Lobby — start when ready",
  };

  return {
    state,
    apiKey: request.apiKey.trim(),
    humanParticipantId,
    turnGeneration: 0,
    waitingForHuman: null,
    rpgPrefetch: null,
    rpgAdvanceInFlight: null,
  };
}

function restoreStateAfterRestart(state: TableState): TableState {
  let next: TableState = state;
  if (state.phase === "running") {
    next = {
      ...state,
      phase: "paused",
      activeSpeakerId: null,
      statusMessage: "Session reloaded — resume to continue",
      error: null,
    };
  }
  // Prefetch is runtime-only — never keep a stale ready/revealing advance after reload.
  if (isRpgState(next.moduleState)) {
    next = withRpgAdvance(next, { speakerId: null, mode: "idle" });
  }
  return next;
}

export class LocalSessionController {
  private session: RuntimeSession | null = null;
  private listeners = new Set<() => void>();
  private releaseLock: (() => void) | null = null;
  private readOnlyFlag = false;
  private errorMessage: string | null = null;
  private lastPrepareProgressAt = 0;
  private pendingApiKey = "";

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Viewer-facing state (hole cards / GM secrets redacted).
   * Game logic must use `session.state` internally — never this getter.
   */
  get state(): TableState | null {
    const session = this.session;
    if (!session) {
      return null;
    }
    const redact = getModule(session.state.moduleId).redactState;
    if (!redact) {
      return session.state;
    }
    return redact(session.state, session.humanParticipantId);
  }

  get humanParticipantId(): ParticipantId | null {
    return this.session?.humanParticipantId ?? null;
  }

  get sessionId(): string | null {
    return this.session?.state.sessionId ?? null;
  }

  get readOnly(): boolean {
    return this.readOnlyFlag;
  }

  get error(): string | null {
    return this.errorMessage ?? this.session?.state.error ?? null;
  }

  setApiKey(apiKey: string): void {
    this.pendingApiKey = apiKey.trim();
    if (this.session) {
      this.session.apiKey = this.pendingApiKey;
    }
  }

  /** Flush the live session snapshot into IndexedDB (no-op if none / read-only). */
  async flushToStorage(): Promise<void> {
    if (!this.session || this.readOnlyFlag) {
      return;
    }
    await this.persistStored();
  }

  async create(request: CreateSessionRequest): Promise<void> {
    await this.teardownRuntime({ clearActiveId: false });
    const built = buildSessionFromRequest(request);
    this.pendingApiKey = built.apiKey;
    this.session = built;
    this.errorMessage = null;
    this.readOnlyFlag = false;
    await this.persistStored();
    await this.acquireLock(built.state.sessionId);
    this.emit(true);
  }

  async loadActive(): Promise<boolean> {
    await this.teardownRuntime({ clearActiveId: false });
    const activeId = await getActiveSessionId();
    if (!activeId) {
      this.session = null;
      this.errorMessage = null;
      this.readOnlyFlag = false;
      this.notify();
      return false;
    }

    const stored = await getStoredSession(activeId);
    if (!stored) {
      await setActiveSessionId(null);
      this.session = null;
      this.errorMessage = null;
      this.readOnlyFlag = false;
      this.notify();
      return false;
    }

    const wasRunning = stored.state.phase === "running";
    const state = restoreStateAfterRestart(stored.state);
    this.session = {
      state,
      apiKey: this.pendingApiKey,
      humanParticipantId: stored.humanParticipantId,
      turnGeneration: 0,
      waitingForHuman: null,
      rpgPrefetch: null,
      rpgAdvanceInFlight: null,
    };
    this.errorMessage = null;

    const locked = await this.acquireLock(activeId);
    if (!locked) {
      this.readOnlyFlag = true;
      this.errorMessage = "Session is open in another tab — viewing read-only";
    }

    if (wasRunning) {
      await this.emit(true);
    } else {
      this.notify();
    }
    return true;
  }

  async leave(): Promise<void> {
    if (this.session && !this.readOnlyFlag) {
      this.pauseInternal();
      await this.persistStored();
    }
    await this.releaseWebLock();
    await setActiveSessionId(null);
    this.session = null;
    this.readOnlyFlag = false;
    this.errorMessage = null;
    this.notify();
  }

  async start(): Promise<void> {
    const session = this.requireWritableSession();
    if (session.state.phase === "running") {
      return;
    }
    const mod = getModule(session.state.moduleId);
    session.rpgPrefetch = null;
    session.state = {
      ...mod.onStart(session.state),
      phase: "running",
      error: null,
    };
    if (this.isRpgModule(session) && isRpgState(session.state.moduleState)) {
      session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
    }
    if (!session.state.statusMessage) {
      session.state.statusMessage = "Starting…";
    }
    await this.emit(true);
    if (this.isRpgModule(session)) {
      void this.prepareRpgAdvance();
    } else {
      void this.runTurnLoop();
    }
  }

  pause(): void {
    this.requireWritableSession();
    this.pauseInternal();
    void this.emit(true);
  }

  async resume(): Promise<void> {
    const session = this.requireWritableSession();
    if (session.state.phase === "running") {
      return;
    }
    session.rpgPrefetch = null;
    session.state = {
      ...session.state,
      phase: "running",
      statusMessage: "Resuming…",
      error: null,
    };
    if (this.isRpgModule(session) && isRpgState(session.state.moduleState)) {
      session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
    }
    await this.emit(true);
    if (this.isRpgModule(session)) {
      void this.prepareRpgAdvance();
    } else {
      void this.runTurnLoop();
    }
  }

  async submitAction(action: ClientAction): Promise<void> {
    const session = this.requireWritableSession();
    const actorId = session.humanParticipantId;
    if (!actorId) {
      throw new Error("No human participant in this session");
    }

    const mod = getModule(session.state.moduleId);
    const rules = mod.createRules();
    const actor = findParticipant(session.state, actorId);

    // Hand raise/lower must not cancel a pending GM Next; may retake a PC slot.
    if (action.type === "rpg.raiseHand" || action.type === "rpg.lowerHand") {
      if (!this.isRpgModule(session) || !isRpgState(session.state.moduleState)) {
        throw new Error("Hand signals are only available during roleplaying");
      }
      const before = normalizeRpgState(session.state.moduleState);
      const wasAwaitingSelf =
        before.advance.mode === "awaiting_human" && before.advance.speakerId === actorId;

      session.state = rules.apply(session.state, action, actorId);
      await this.emit(true);

      if (session.state.phase !== "running") {
        return;
      }

      if (action.type === "rpg.lowerHand" && wasAwaitingSelf) {
        session.turnGeneration += 1;
        session.rpgPrefetch = null;
        void this.prepareRpgAdvance();
        return;
      }

      if (action.type === "rpg.raiseHand") {
        if (!isRpgState(session.state.moduleState)) {
          throw new Error("RPG moduleState is missing or invalid");
        }
        const rpg = normalizeRpgState(session.state.moduleState);
        if (rpg.preferGmNext) {
          return;
        }
        const queued =
          rpg.advance.speakerId != null
            ? findParticipant(session.state, rpg.advance.speakerId)
            : null;
        const retakePcSlot =
          rpg.advance.mode === "preparing" || rpg.advance.mode === "ready"
            ? queued == null || (queued.kind === "llm" && queued.tableRole !== "gm")
            : false;
        if (retakePcSlot) {
          session.turnGeneration += 1;
          session.rpgPrefetch = null;
          session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
          await this.emit(true);
          void this.prepareRpgAdvance();
        }
      }
      return;
    }

    let wasAwaitingSelf = false;
    if (this.isRpgModule(session) && isRpgState(session.state.moduleState)) {
      const rpgBefore = normalizeRpgState(session.state.moduleState);
      wasAwaitingSelf =
        rpgBefore.advance.mode === "awaiting_human" &&
        rpgBefore.advance.speakerId === actorId;
    }

    session.turnGeneration += 1;
    session.waitingForHuman = null;
    session.rpgPrefetch = null;

    session.state = rules.apply(session.state, action, actorId);
    await this.maybeRefreshRpgSummary();

    if (this.isRpgModule(session) && isRpgState(session.state.moduleState)) {
      session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
    }

    if (actor.kind === "human") {
      this.setStatus(
        action.type === "poker.act"
          ? `${actor.displayName} acted — next player…`
          : action.type === "rpg.say" || action.type === "rpg.gm"
            ? wasAwaitingSelf
              ? `${actor.displayName} spoke — rebuilding next line…`
              : `${actor.displayName} interrupted — rebuilding next line…`
            : `${actor.displayName} spoke — continuing…`,
      );
    } else {
      this.setStatus("Continuing…");
    }
    await this.emit(true);

    if (session.state.phase === "running") {
      if (this.isRpgModule(session)) {
        void this.prepareRpgAdvance();
      } else {
        void this.runTurnLoop();
      }
    }
  }

  async advanceRpg(): Promise<void> {
    const session = this.requireWritableSession();
    if (session.rpgAdvanceInFlight) {
      await session.rpgAdvanceInFlight;
      return;
    }

    const run = this.advanceRpgSession().finally(() => {
      if (session.rpgAdvanceInFlight === run) {
        session.rpgAdvanceInFlight = null;
      }
    });
    session.rpgAdvanceInFlight = run;
    await run;
  }

  async continuePokerNextHand(): Promise<void> {
    const session = this.requireWritableSession();
    if (session.state.moduleId !== "poker") {
      throw new Error("Next hand is only available during poker");
    }
    if (!isPokerState(session.state.moduleState)) {
      throw new Error("Poker state is missing");
    }

    session.turnGeneration += 1;
    session.waitingForHuman = null;

    const nextPoker = continueToNextHand(session.state.moduleState);
    session.state = withPokerChatWindow(
      {
        ...session.state,
        phase: "running",
        moduleState: nextPoker,
        activeSpeakerId: nextPoker.actingParticipantId,
        statusMessage: nextPoker.lastActionSummary ?? "New hand dealt",
        error: null,
      },
      nextPoker.handNumber,
    );
    await this.emit(true);
    void this.runTurnLoop();
  }

  setGmImages(enabled: boolean, imageModel?: string): void {
    const session = this.requireWritableSession();
    if (session.state.moduleId !== "rpg") {
      throw new Error("GM pictures setting is only available during roleplaying");
    }

    const nextModel = imageModel?.trim();
    session.state = {
      ...session.state,
      gmImagesEnabled: enabled,
      ...(nextModel ? { imageModel: nextModel } : {}),
      statusMessage: enabled
        ? "GM pictures enabled"
        : "GM pictures disabled",
      error: null,
    };

    if (enabled && !session.state.imageModel?.trim()) {
      session.state = {
        ...session.state,
        gmImagesEnabled: false,
        error: "Choose an image model in settings before enabling GM pictures",
        statusMessage: "GM pictures need an image model",
      };
    }

    void this.emit(true);
  }

  private requireWritableSession(): RuntimeSession {
    if (!this.session) {
      throw new Error("No active session");
    }
    if (this.readOnlyFlag) {
      throw new Error("Session is read-only (open in another tab)");
    }
    return this.session;
  }

  private requireSession(): RuntimeSession {
    if (!this.session) {
      throw new Error("No active session");
    }
    return this.session;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async emit(persist: boolean): Promise<void> {
    this.notify();
    if (persist && this.session) {
      await this.persistStored();
    }
  }

  private async persistStored(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    const row: StoredSession = {
      sessionId: session.state.sessionId,
      state: session.state,
      humanParticipantId: session.humanParticipantId,
      updatedAt: Date.now(),
    };
    await putStoredSession(row);
    await setActiveSessionId(session.state.sessionId);
  }

  private async acquireLock(sessionId: string): Promise<boolean> {
    await this.releaseWebLock();

    if (typeof navigator === "undefined" || !navigator.locks?.request) {
      this.readOnlyFlag = false;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      void navigator.locks.request(
        `llm-table-session:${sessionId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            this.readOnlyFlag = true;
            resolve(false);
            return;
          }
          this.readOnlyFlag = false;
          resolve(true);
          await new Promise<void>((r) => {
            this.releaseLock = r;
          });
          this.releaseLock = null;
        },
      );
    });
  }

  private async releaseWebLock(): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = null;
    if (release) {
      release();
      // Let the lock callback settle before requesting another.
      await sleep(0);
    }
  }

  private async teardownRuntime(opts: { clearActiveId: boolean }): Promise<void> {
    if (this.session && !this.readOnlyFlag) {
      this.pauseInternal();
    }
    await this.releaseWebLock();
    if (opts.clearActiveId) {
      await setActiveSessionId(null);
    }
    this.session = null;
    this.readOnlyFlag = false;
  }

  private pauseInternal(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    session.turnGeneration += 1;
    session.waitingForHuman = null;
    session.rpgPrefetch = null;
    let nextState: TableState = {
      ...session.state,
      phase: "paused",
      activeSpeakerId: null,
      statusMessage: "Paused",
      error: null,
    };
    if (isRpgState(nextState.moduleState)) {
      nextState = withRpgAdvance(nextState, { speakerId: null, mode: "idle" });
    }
    session.state = nextState;
  }

  private isRpgModule(session: RuntimeSession): boolean {
    return session.state.moduleId === "rpg";
  }

  private setStatus(statusMessage: string | null, error: string | null = null): void {
    const session = this.requireSession();
    session.state = {
      ...session.state,
      statusMessage,
      error,
    };
  }

  private async waitForHumanTurnOrTimeout(
    humanId: ParticipantId,
    generation: number,
    timeoutMs: number,
  ): Promise<"spoke" | "timeout" | "cancelled"> {
    const session = this.requireSession();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (session.turnGeneration !== generation || session.state.phase !== "running") {
        return "cancelled";
      }
      if (session.waitingForHuman !== humanId) {
        return "spoke";
      }
      await sleep(200);
    }

    if (session.turnGeneration !== generation || session.state.phase !== "running") {
      return "cancelled";
    }
    if (session.waitingForHuman !== humanId) {
      return "spoke";
    }
    return "timeout";
  }

  private publishRpgPrepareProgress(opts: {
    generation: number;
    speakerId: ParticipantId | null;
    progress: RpgPreparationProgress;
    statusMessage: string;
    force?: boolean;
  }): void {
    const session = this.session;
    if (
      !session ||
      opts.generation !== session.turnGeneration ||
      session.state.phase !== "running" ||
      !this.isRpgModule(session)
    ) {
      return;
    }

    const now = Date.now();
    if (!opts.force && now - this.lastPrepareProgressAt < PREPARE_PROGRESS_THROTTLE_MS) {
      return;
    }
    this.lastPrepareProgressAt = now;

    session.state = {
      ...withRpgAdvance(session.state, {
        speakerId: opts.speakerId,
        mode: "preparing",
        progress: opts.progress,
      }),
      activeSpeakerId: opts.speakerId,
      error: null,
      statusMessage: opts.statusMessage,
    };
    void this.emit(false);
  }

  private makeStreamingComplete(opts: {
    generation: number;
    getSpeakerId: () => ParticipantId | null;
    phase: RpgPreparationProgress["phase"];
    statusPrefix: string;
  }) {
    return async (params: {
      apiKey: string;
      model: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      temperature?: number;
      responseFormat?: "json_object";
    }): Promise<string> => {
      return chatCompletion({
        ...params,
        onProgress: (progress) => {
          const detail = formatChatProgressDetail(progress);
          this.publishRpgPrepareProgress({
            generation: opts.generation,
            speakerId: opts.getSpeakerId(),
            progress: {
              phase: opts.phase,
              detail,
              receivedBytes: progress.receivedBytes,
              receivedChars: progress.receivedChars,
              promptTokens: progress.promptTokens,
              completionTokens: progress.completionTokens,
              totalTokens: progress.totalTokens,
            },
            statusMessage: `${opts.statusPrefix} — ${detail}`,
          });
        },
      });
    };
  }

  private async maybeRefreshRpgSummary(): Promise<void> {
    const session = this.requireSession();
    if (!this.isRpgModule(session)) {
      return;
    }
    const next = await maybeRefreshTranscriptSummary(session.state, {
      apiKey: session.apiKey,
      coordinatorModel: session.state.coordinatorModel,
      complete: chatCompletion,
    });
    if (next !== session.state) {
      session.state = next;
    }
  }

  private formatTranscriptForPersona(state: TableState): string {
    const recent = state.messages.slice(-TRANSCRIPT_WINDOW);
    if (recent.length === 0) {
      return "The table is quiet. Start the conversation naturally in character.";
    }
    return recent.map((m) => `${m.displayName}: ${m.content}`).join("\n");
  }

  private async generateConversationLine(speaker: Participant): Promise<ClientAction> {
    const session = this.requireSession();
    if (!speaker.persona) {
      throw new Error(`LLM participant ${speaker.displayName} has no persona definition`);
    }

    const others = session.state.participants
      .filter((p) => p.id !== speaker.id)
      .map((p) => p.displayName)
      .join(", ");

    const system = [
      speaker.persona.systemPrompt,
      "",
      "You are seated at a conversation table with: " + (others || "no one else yet") + ".",
      "Stay in character. Reply with only what you say at the table — no stage directions, no name prefix.",
      "Keep replies concise (1–3 short paragraphs unless the moment clearly needs more).",
    ].join("\n");

    const content = await chatCompletion({
      apiKey: session.apiKey,
      model: speaker.persona.model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Transcript so far:\n${this.formatTranscriptForPersona(session.state)}\n\nSpeak now as ${speaker.displayName}.`,
        },
      ],
      temperature: 0.8,
    });

    return { type: "chat.say", content };
  }

  private async generateLlmAction(
    speaker: Participant,
    complete: typeof chatCompletion = chatCompletion,
  ): Promise<ClientAction> {
    const session = this.requireSession();
    const mod = getModule(session.state.moduleId);
    if (mod.generateLlmTurn) {
      return mod.generateLlmTurn({
        apiKey: session.apiKey,
        complete,
        state: session.state,
        participant: speaker,
      });
    }
    return this.generateConversationLine(speaker);
  }

  private async maybeAttachGmImage(
    action: ClientAction,
    onProgress?: (progress: ImageGenerationProgress) => void,
  ): Promise<ClientAction> {
    const session = this.requireSession();
    if (action.type !== "rpg.gm") {
      return action;
    }
    const prompt = action.imagePrompt?.trim();
    if (!prompt) {
      return action;
    }
    if (session.state.gmImagesEnabled !== true) {
      return { ...action, imagePrompt: undefined };
    }
    const model = session.state.imageModel?.trim();
    if (!model) {
      return { ...action, imagePrompt: undefined };
    }

    try {
      const visualCast = session.state.participants
        .filter((p) => p.tableRole !== "gm" && p.persona?.systemPrompt.trim())
        .map((p) => formatPersonaVisualCastLine(p.persona!.systemPrompt));
      const visualBlock =
        visualCast.length > 0
          ? [
              "Character appearance references from their personas (sex + visual cues).",
              "When the scene includes people who match these looks, use these details; do not invent conflicting sexes or outfits.",
              "Do not render names, labels, or text in the image.",
              ...visualCast.map((line, i) => `${i + 1}. ${line}`),
            ].join(" ")
          : "";

      const { dataUrl } = await generateImage({
        apiKey: session.apiKey,
        model,
        prompt: [
          "Fantasy tabletop RPG illustration for the players.",
          "Cinematic, atmospheric, no text, no UI, no watermark.",
          "Depict only people clearly present in the scene description.",
          "Honor each person's sex/gender presentation and visual cues from the appearance references.",
          "Do not add extra anonymous party members unless the scene asks for them.",
          visualBlock,
          "Scene:",
          prompt,
        ]
          .filter(Boolean)
          .join(" "),
        aspectRatio: "16:9",
        onProgress,
      });
      // Keep imagePrompt so the chat can show it as a tooltip on the picture.
      return { ...action, imageDataUrl: dataUrl };
    } catch {
      // Narration still lands; picture is optional.
      return { ...action, imagePrompt: undefined };
    }
  }

  private async generateAndEnrichLlmAction(
    speaker: Participant,
    opts: { generation: number },
  ): Promise<ClientAction> {
    const session = this.requireSession();
    const complete = this.makeStreamingComplete({
      generation: opts.generation,
      getSpeakerId: () => speaker.id,
      phase: "generating_turn",
      statusPrefix: `Writing ${speaker.displayName}`,
    });

    this.publishRpgPrepareProgress({
      generation: opts.generation,
      speakerId: speaker.id,
      progress: {
        phase: "generating_turn",
        detail: "Opening model stream…",
      },
      statusMessage: `Writing ${speaker.displayName} — opening model stream…`,
      force: true,
    });

    const action = await this.generateLlmAction(speaker, complete);

    if (action.type === "rpg.gm" && action.imagePrompt?.trim() && session.state.gmImagesEnabled === true) {
      this.publishRpgPrepareProgress({
        generation: opts.generation,
        speakerId: speaker.id,
        progress: {
          phase: "creating_image",
          detail: "Starting image generation…",
        },
        statusMessage: `Creating scene image for ${speaker.displayName}…`,
        force: true,
      });

      return this.maybeAttachGmImage(action, (progress) => {
        const detail = formatImageProgressDetail(progress);
        this.publishRpgPrepareProgress({
          generation: opts.generation,
          speakerId: speaker.id,
          progress: {
            phase: "creating_image",
            detail,
            receivedBytes: progress.receivedBytes,
            imagePartialFrames: progress.partialFrames,
          },
          statusMessage: `Creating scene image — ${detail}`,
          force: progress.done,
        });
      });
    }

    this.publishRpgPrepareProgress({
      generation: opts.generation,
      speakerId: speaker.id,
      progress: {
        phase: "finalizing",
        detail: "Finishing turn…",
      },
      statusMessage: `Finalizing ${speaker.displayName}…`,
      force: true,
    });

    return this.maybeAttachGmImage(action);
  }

  private async prepareRpgAdvance(): Promise<void> {
    const session = this.session;
    if (!session || !this.isRpgModule(session) || session.state.phase !== "running") {
      return;
    }
    if (!isRpgState(session.state.moduleState)) {
      throw new Error("RPG moduleState is missing or invalid");
    }

    const generation = session.turnGeneration;
    session.rpgPrefetch = null;
    session.waitingForHuman = null;

    const mod = getModule(session.state.moduleId);
    this.publishRpgPrepareProgress({
      generation,
      speakerId: null,
      progress: {
        phase: "choosing_speaker",
        detail: "Asking coordinator who acts next…",
      },
      statusMessage: "Choosing next speaker…",
      force: true,
    });

    const coordinatorComplete = this.makeStreamingComplete({
      generation,
      getSpeakerId: () => null,
      phase: "choosing_speaker",
      statusPrefix: "Choosing next speaker",
    });

    const coordinator = mod.createCoordinator({
      apiKey: session.apiKey,
      coordinatorModel: session.state.coordinatorModel,
      complete: coordinatorComplete,
    });

    let nextId: ParticipantId | null;
    try {
      nextId = await coordinator.pickNext(session.state);
    } catch (err) {
      if (generation !== session.turnGeneration) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      session.state = {
        ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
        phase: "paused",
        activeSpeakerId: null,
        error: message,
        statusMessage: "Coordinator failed",
      };
      await this.emit(true);
      return;
    }

    if (generation !== session.turnGeneration || session.state.phase !== "running") {
      return;
    }

    if (!nextId) {
      session.state = {
        ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
        phase: "paused",
        activeSpeakerId: null,
        error: "No eligible actor",
        statusMessage: "Paused — no eligible actor",
      };
      await this.emit(true);
      return;
    }

    const speaker = findParticipant(session.state, nextId);

    if (speaker.kind === "human") {
      const rpgNow = normalizeRpgState(session.state.moduleState);
      // Hand may have been lowered while the coordinator was running.
      if (rpgNow.raisedHandParticipantId !== speaker.id) {
        void this.prepareRpgAdvance();
        return;
      }
      session.rpgPrefetch = null;
      session.state = {
        ...withRpgAdvance(session.state, {
          speakerId: speaker.id,
          mode: "awaiting_human",
        }),
        activeSpeakerId: speaker.id,
        error: null,
        statusMessage: `${speaker.displayName} — your turn (hand raised)`,
      };
      await this.emit(true);
      return;
    }

    this.publishRpgPrepareProgress({
      generation,
      speakerId: speaker.id,
      progress: {
        phase: "generating_turn",
        detail: "Opening model stream…",
      },
      statusMessage: `Next: ${speaker.displayName} — writing…`,
      force: true,
    });

    const promise = this.generateAndEnrichLlmAction(speaker, { generation });

    session.rpgPrefetch = {
      generation,
      speakerId: speaker.id,
      promise,
      action: null,
      error: null,
    };

    try {
      const action = await promise;
      if (
        generation !== session.turnGeneration ||
        session.state.phase !== "running" ||
        session.rpgPrefetch?.generation !== generation
      ) {
        return;
      }
      session.rpgPrefetch = {
        ...session.rpgPrefetch,
        action,
      };
      const withPicture =
        action.type === "rpg.gm" && Boolean(action.imageDataUrl?.trim());
      session.state = {
        ...withRpgAdvance(session.state, {
          speakerId: speaker.id,
          mode: "ready",
        }),
        activeSpeakerId: speaker.id,
        error: null,
        statusMessage: withPicture
          ? `Next: ${speaker.displayName} — press Next (picture ready)`
          : `Next: ${speaker.displayName} — press Next`,
      };
      await this.emit(true);
    } catch (err) {
      if (generation !== session.turnGeneration) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      session.rpgPrefetch = null;
      session.state = {
        ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
        phase: "paused",
        activeSpeakerId: null,
        error: message,
        statusMessage: `${speaker.displayName} failed to prepare`,
      };
      await this.emit(true);
    }
  }

  private async advanceRpgSession(): Promise<void> {
    const session = this.requireWritableSession();
    if (!this.isRpgModule(session)) {
      throw new Error("Advance is only available during roleplaying");
    }
    if (session.state.phase !== "running") {
      throw new Error("Table must be running to advance");
    }
    if (!isRpgState(session.state.moduleState)) {
      throw new Error("RPG moduleState is missing or invalid");
    }

    const rpg = normalizeRpgState(session.state.moduleState);
    if (rpg.advance.mode === "awaiting_human") {
      throw new Error("Waiting for your line — speak or lower your hand before Next");
    }
    if (rpg.advance.mode === "revealing") {
      return;
    }
    if (rpg.advance.mode === "idle") {
      throw new Error("Nothing ready to advance yet");
    }
    if (rpg.advance.mode === "preparing" && !rpg.advance.speakerId) {
      throw new Error("Still choosing who acts next — try again in a moment");
    }
    if (!rpg.advance.speakerId) {
      throw new Error("Nothing ready to advance yet");
    }

    const speakerId = rpg.advance.speakerId;
    const speaker = findParticipant(session.state, speakerId);
    const generation = session.turnGeneration;

    session.state = {
      ...withRpgAdvance(session.state, { speakerId, mode: "revealing" }),
      activeSpeakerId: speakerId,
      statusMessage: `Revealing ${speaker.displayName}…`,
      error: null,
    };
    await this.emit(true);

    try {
      let prefetch = session.rpgPrefetch;

      if (!prefetch || prefetch.speakerId !== speakerId || prefetch.generation !== generation) {
        const promise = this.generateAndEnrichLlmAction(speaker, { generation });
        prefetch = {
          generation,
          speakerId,
          promise,
          action: null,
          error: null,
        };
        session.rpgPrefetch = prefetch;
        this.setStatus(`Next: ${speaker.displayName} — preparing…`);
        await this.emit(true);
      }

      if (!prefetch.action) {
        this.setStatus(`Next: ${speaker.displayName} — almost ready…`);
        await this.emit(true);
        try {
          const action = await prefetch.promise;
          if (session.turnGeneration !== generation || session.state.phase !== "running") {
            throw new Error("Advance was interrupted — press Next again when ready");
          }
          prefetch = { ...prefetch, action };
          session.rpgPrefetch = prefetch;
        } catch (err) {
          if (session.turnGeneration !== generation) {
            throw new Error("Advance was interrupted — press Next again when ready");
          }
          const message = err instanceof Error ? err.message : String(err);
          session.rpgPrefetch = null;
          session.state = {
            ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
            phase: "paused",
            activeSpeakerId: null,
            error: message,
            statusMessage: `${speaker.displayName} failed to act`,
          };
          await this.emit(true);
          throw new Error(message);
        }
      }

      const action = prefetch.action;
      if (!action) {
        throw new Error("Prefetch completed without an action");
      }

      session.turnGeneration += 1;
      session.rpgPrefetch = null;
      session.waitingForHuman = null;

      const rules = getModule(session.state.moduleId).createRules();
      session.state = rules.apply(session.state, action, speakerId);
      await this.maybeRefreshRpgSummary();
      session.state = {
        ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
        activeSpeakerId: null,
        statusMessage: `${speaker.displayName} spoke — press Next when ready`,
        error: null,
      };
      await this.emit(true);

      if (session.state.phase === "running") {
        void this.prepareRpgAdvance();
      }
    } catch (err) {
      if (
        this.session === session &&
        isRpgState(session.state.moduleState) &&
        normalizeRpgState(session.state.moduleState).advance.mode === "revealing"
      ) {
        session.state = {
          ...withRpgAdvance(session.state, {
            speakerId,
            mode: session.rpgPrefetch?.action ? "ready" : "idle",
          }),
          activeSpeakerId: session.rpgPrefetch?.action ? speakerId : null,
          statusMessage:
            session.rpgPrefetch?.action != null
              ? `Next: ${speaker.displayName} — press Next`
              : "Advance failed — preparing again…",
          error: err instanceof Error ? err.message : String(err),
        };
        await this.emit(true);
        if (!session.rpgPrefetch?.action && session.state.phase === "running") {
          void this.prepareRpgAdvance();
        }
      }
      throw err;
    }
  }

  private async runTurnLoop(): Promise<void> {
    const session = this.requireSession();
    if (this.isRpgModule(session)) {
      void this.prepareRpgAdvance();
      return;
    }

    const generation = ++session.turnGeneration;

    const stillCurrent = () =>
      generation === session.turnGeneration && session.state.phase === "running";

    while (stillCurrent()) {
      const mod = getModule(session.state.moduleId);
      const rules = mod.createRules();
      if (!rules.isActive(session.state)) {
        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          statusMessage: "Table finished",
        };
        await this.emit(true);
        return;
      }

      this.setStatus("Determining next actor…");
      await this.emit(true);

      const coordinator = mod.createCoordinator({
        apiKey: session.apiKey,
        coordinatorModel: session.state.coordinatorModel,
        complete: chatCompletion,
      });

      let nextId: ParticipantId | null;
      try {
        nextId = await coordinator.pickNext(session.state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          error: message,
          statusMessage: "Coordinator failed",
        };
        await this.emit(true);
        return;
      }

      if (!stillCurrent()) {
        return;
      }

      // Coordinator may have advanced moduleState (e.g. new poker hand)
      await this.emit(true);

      if (!nextId) {
        const poker = isPokerState(session.state.moduleState)
          ? session.state.moduleState
          : null;
        if (poker && isAwaitingNextHand(poker)) {
          session.state = {
            ...session.state,
            phase: "paused",
            activeSpeakerId: null,
            error: null,
            statusMessage:
              session.state.statusMessage ??
              "Hand complete — press Next hand when ready",
          };
          await this.emit(true);
          return;
        }
        if (
          poker &&
          poker.street === "betweenHands" &&
          poker.players.filter((p) => p.stack > 0).length < 2
        ) {
          session.state = {
            ...session.state,
            phase: "paused",
            activeSpeakerId: null,
            error: null,
            statusMessage: session.state.statusMessage ?? "Table finished",
          };
          await this.emit(true);
          return;
        }

        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          error: "No eligible actor",
          statusMessage: "Paused — no eligible actor",
        };
        await this.emit(true);
        return;
      }

      const speaker = findParticipant(session.state, nextId);
      const timeoutMs =
        mod.humanTurnTimeoutMs === null
          ? null
          : (mod.humanTurnTimeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS);
      session.state = {
        ...session.state,
        activeSpeakerId: nextId,
        error: null,
        statusMessage:
          speaker.kind === "human"
            ? `Waiting for ${speaker.displayName}…`
            : `${speaker.displayName} is acting…`,
      };
      await this.emit(true);

      if (speaker.kind === "human") {
        session.waitingForHuman = speaker.id;
        session.state = {
          ...session.state,
          statusMessage:
            timeoutMs === null
              ? `Waiting for ${speaker.displayName}…`
              : `Waiting for ${speaker.displayName}… (will skip if silent)`,
        };
        await this.emit(true);

        if (timeoutMs === null) {
          while (
            generation === session.turnGeneration &&
            session.state.phase === "running" &&
            session.waitingForHuman === speaker.id
          ) {
            await sleep(200);
          }
          return;
        }

        const waitResult = await this.waitForHumanTurnOrTimeout(
          speaker.id,
          generation,
          timeoutMs,
        );

        if (waitResult === "spoke" || waitResult === "cancelled") {
          return;
        }

        session.waitingForHuman = null;
        session.state = {
          ...session.state,
          activeSpeakerId: null,
          statusMessage: `${speaker.displayName} passed — continuing`,
        };
        await this.emit(true);
        continue;
      }

      try {
        const action = await this.generateLlmAction(speaker);

        if (!stillCurrent()) {
          return;
        }
        session.state = rules.apply(session.state, action, speaker.id);
        this.setStatus("Next…");
        await this.emit(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          error: message,
          statusMessage: `${speaker.displayName} failed to act`,
        };
        await this.emit(true);
        return;
      }
    }
  }
}
