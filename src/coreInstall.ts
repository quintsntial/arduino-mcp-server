/**
 * Pure helpers for installing board cores with third-party package index URLs (BOARD_URLS in
 * tools/board.env, e.g. the esp8266 package). Kept free of I/O so the argument lists can be tested.
 */

/** Trim, drop empty entries and duplicates, keep order. */
export function normalizeBoardUrls(urls: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of urls ?? []) {
    const url = raw.trim();
    if (url && !out.includes(url)) {
      out.push(url);
    }
  }
  return out;
}

/** The URLs to use: an explicit boardUrls argument wins, else BOARD_URLS from the project's board.env. */
export function resolveBoardUrls(explicit: readonly string[] | undefined, fromProject: readonly string[] | undefined): {
  urls: string[];
  source: "argument" | "board.env" | "none";
} {
  const given = normalizeBoardUrls(explicit);
  if (given.length > 0) {
    return { urls: given, source: "argument" };
  }
  const project = normalizeBoardUrls(fromProject);
  if (project.length > 0) {
    return { urls: project, source: "board.env" };
  }
  return { urls: [], source: "none" };
}

/** arduino-cli takes one comma separated --additional-urls value. */
export function additionalUrlsArgs(urls: readonly string[]): string[] {
  return urls.length > 0 ? ["--additional-urls", urls.join(",")] : [];
}

export interface CoreCommandArgs {
  list: string[];
  updateIndex: string[];
  install: string[];
}

/** The three arduino-cli invocations used by ensureCoreInstalled. */
export function coreCommandArgs(coreId: string, urls: readonly string[]): CoreCommandArgs {
  const extra = additionalUrlsArgs(urls);
  return {
    list: ["core", "list", "--format", "json", ...extra],
    updateIndex: ["core", "update-index", ...extra],
    install: ["core", "install", coreId, ...extra]
  };
}
