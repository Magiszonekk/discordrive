// Methods of the application core the desktop window may call through the agent, with a check of the
// argument types. The window is untrusted input to the agent: anything not listed here is refused, and a
// call with wrong argument types is refused before it reaches the core. (The browser worker relies on the
// worker being private to the page; the agent outlives windows, so it checks.)
type Kind = "s" | "n" | "b" | "o" | "a" | "s[]" | "any";
/** Argument kinds per method; a trailing "?" = optional. */
export const CORE_METHODS: Record<string, string[]> = {
  status: [],
  instance: ["s"],
  createAccount: ["s", "s", "s?"],
  open: [],
  retryAuth: [],
  forgetThisBrowser: [],
  accountInfo: [],
  authProblem: ["s"],
  adminAccounts: [],
  adminAccount: ["s"],
  adminBlock: ["s", "s"],
  adminUnblock: ["s"],
  adminSetAdmin: ["s", "b"],
  adminDelete: ["s"],
  adminRevokeDevice: ["s", "s"],
  adminInvites: [],
  adminCreateInvite: ["n", "s"],
  adminRevokeInvite: ["s"],
  adminInstance: [],
  adminDoctor: [],
  adminSetSignup: ["s"],
  adminLog: ["s?", "n?"],
  unfinishedUploads: [],
  forgetUnfinished: ["s"],
  setNetPrefs: ["o"],
  speedTest: ["o?"],
  speedTestCancel: [],
  netUseLane: ["n"],
  setOnline: ["b"],
  netStatus: [],
  storageStatus: [],
  cleanup: ["b?"],
  addWebhook: ["s"],
  webhooks: ["b?"],
  channelImpact: ["s"],
  channelFiles: ["s"],
  retireWebhook: ["s", "b?"],
  moveWebhook: ["s"],
  moveStatus: [],
  removeWebhook: ["s"],
  recoverWebhook: ["s"],
  refreshUnavailable: [],
  setShowUnavailable: ["b"],
  unavailableInfo: ["s"],
  storageTotals: [],
  list: ["s?", "s?", "n?", "o?"],
  folderStats: ["s?"],
  folderPath: ["s"],
  mkdir: ["s", "s?"],
  capabilities: [],
  uploadPaths: ["s[]", "s?", "s?"],
  listPaths: ["s[]"],
  uploadPath: ["s", "s[]?", "s?", "s?", "b?"],
  uploadPreviews: ["s", "any"],
  preview: ["s", "s?"],
  knownPreviews: ["s[]"],
  backfillState: [],
  backfillNext: ["n?", "b?"],
  backfillAdd: ["s", "any"],
  backfillEnd: [],
  downloadToDisk: ["s", "s?", "s?"],
  unfinishedDownloads: [],
  resumeDownloads: [],
  features: [],
  thumbnail: ["s"],
  search: ["s", "s?"],
  streamUrl: ["s"],
  cancelUpload: ["s"],
  download: ["s", "s?"],
  fileInfo: ["s"],
  cancelDownload: ["s"],
  setConcurrency: ["any", "any"],
  concurrency: [],
  setTransferLog: ["b", "b?"],
  buildInfo: [],
  transferLogStatus: [],
  transferLogFile: [],
  clearTransferLog: [],
  readRange: ["s", "n", "n"],
  rename: ["s", "s"],
  move: ["s[]", "s"],
  moveBack: ["o"],
  trash: ["any"],
  restore: ["s[]"],
  purge: ["s[]"],
  emptyTrash: [],
  trashList: [],
  recoveredCount: [],
  galleryAvailable: [],
  subfolders: ["s?"],
  pairAccept: ["s"],
  pairStart: ["s", "s"],
  pairPoll: [],
  pairConfirm: [],
  pairCancel: [],
  passwordKeyStatus: [],
  setPasswordKey: ["s", "s"],
  removePasswordKey: [],
  passwordStrength: ["s"],
  joinWithPassword: ["s", "s", "s", "s"],
  joinWithKit: ["s", "s", "s"],
  devices: [],
  renameDevice: ["s", "s"],
  revokeDevice: ["s"],
  rescueKit: [],
  confirmKitSaved: [],
  kitReminder: [],
  snapshotSoon: ["b?"],
  shareFile: ["s", "s"],
  shares: [],
  revokeShare: ["s"],
  shareOpen: ["s", "s", "s"],
  shareDownload: [],
};

const ok = (k: Kind, v: unknown): boolean => {
  switch (k) {
    case "s":
      return typeof v === "string" && v.length <= 1 << 20;
    case "n":
      return typeof v === "number" && Number.isFinite(v);
    case "b":
      return typeof v === "boolean";
    case "o":
      return !!v && typeof v === "object" && !Array.isArray(v);
    case "a":
      return Array.isArray(v);
    case "s[]":
      return Array.isArray(v) && v.length <= 100_000 && v.every((x) => typeof x === "string");
    case "any":
      return true;
  }
};

/** null when the call may go to the core, else why not. */
export function checkCall(method: unknown, args: unknown): string | null {
  if (typeof method !== "string" || !Object.hasOwn(CORE_METHODS, method)) return `no method ${String(method).slice(0, 40)}`;
  if (!Array.isArray(args)) return "bad arguments";
  const spec = CORE_METHODS[method]!;
  if (args.length > spec.length) return `${method}: too many arguments`;
  for (let i = 0; i < spec.length; i++) {
    const opt = spec[i]!.endsWith("?");
    const k = spec[i]!.replace("?", "") as Kind;
    const v = args[i];
    if (v === undefined || v === null) {
      if (opt || k === "any") continue;
      return `${method}: argument ${i + 1} missing`;
    }
    if (!ok(k, v)) return `${method}: argument ${i + 1} has the wrong type`;
  }
  return null;
}
