export const SKILL_MAINTENANCE_TIMEOUT_MS = 60_000;
export const SKILL_MAINTENANCE_MAX_TURNS = 5;

interface MaintenanceJob {
  run(signal: AbortSignal): Promise<void>;
  dropped(): void;
}

interface VaultQueue {
  running: boolean;
  active: AbortController | null;
  pending: MaintenanceJob | null;
}

const queues = new Map<string, VaultQueue>();
const auxiliaryControllers = new Map<string, Set<AbortController>>();

/** Register synchronous stale-Skill refresh under the same Vault cancellation boundary. */
export function registerSkillMaintenanceActivity(
  vaultPath: string,
  parentSignal: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const controllers = auxiliaryControllers.get(vaultPath) ?? new Set<AbortController>();
  controllers.add(controller);
  auxiliaryControllers.set(vaultPath, controllers);
  const onParentAbort = () => controller.abort(parentSignal.reason ?? "cancelled");
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      parentSignal.removeEventListener("abort", onParentAbort);
      controllers.delete(controller);
      if (controllers.size === 0) auxiliaryControllers.delete(vaultPath);
    },
  };
}

function queueFor(vaultPath: string): VaultQueue {
  const existing = queues.get(vaultPath);
  if (existing) return existing;
  const created: VaultQueue = { running: false, active: null, pending: null };
  queues.set(vaultPath, created);
  return created;
}

async function drain(vaultPath: string): Promise<void> {
  const queue = queueFor(vaultPath);
  if (queue.running) return;
  const job = queue.pending;
  if (!job) return;
  queue.pending = null;
  queue.running = true;
  const controller = new AbortController();
  queue.active = controller;
  const timer = setTimeout(() => controller.abort("timeout"), SKILL_MAINTENANCE_TIMEOUT_MS);
  try {
    await job.run(controller.signal);
  } finally {
    clearTimeout(timer);
    queue.active = null;
    queue.running = false;
    if (queue.pending) void drain(vaultPath);
    else queues.delete(vaultPath);
  }
}

/** Opportunistic maintenance keeps only the newest pending job per Vault. */
export function enqueueSkillMaintenance(
  vaultPath: string,
  run: MaintenanceJob["run"],
  dropped: MaintenanceJob["dropped"],
): void {
  const queue = queueFor(vaultPath);
  queue.pending?.dropped();
  queue.pending = { run, dropped };
  void drain(vaultPath);
}

export function cancelSkillMaintenance(vaultPath?: string): void {
  const targets = vaultPath ? [[vaultPath, queues.get(vaultPath)] as const] : [...queues.entries()];
  for (const [key, queue] of targets) {
    if (!queue) continue;
    queue.pending?.dropped();
    queue.pending = null;
    queue.active?.abort("cancelled");
    if (!queue.running) queues.delete(key);
  }
  const activityTargets = vaultPath
    ? [[vaultPath, auxiliaryControllers.get(vaultPath)] as const]
    : [...auxiliaryControllers.entries()];
  for (const [key, controllers] of activityTargets) {
    if (!controllers) continue;
    for (const controller of controllers) controller.abort("cancelled");
    auxiliaryControllers.delete(key);
  }
}
