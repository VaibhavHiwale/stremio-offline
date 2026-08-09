import type { DebridAccount, DebridService, DownloadItem, Settings, StorageTarget } from "@stremio-offline/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listDownloads: (status?: string) => request<{ items: DownloadItem[] }>(`/downloads${status ? `?status=${status}` : ""}`),
  getDownload: (id: string) => request<DownloadItem>(`/downloads/${id}`),
  pauseDownload: (id: string) => request<DownloadItem>(`/downloads/${id}`, { method: "PATCH", body: JSON.stringify({ action: "pause" }) }),
  resumeDownload: (id: string) => request<DownloadItem>(`/downloads/${id}`, { method: "PATCH", body: JSON.stringify({ action: "resume" }) }),
  retryDownload: (id: string) => request<DownloadItem>(`/downloads/${id}`, { method: "PATCH", body: JSON.stringify({ action: "retry" }) }),
  setPriority: (id: string, priority: number) => request<DownloadItem>(`/downloads/${id}`, { method: "PATCH", body: JSON.stringify({ priority }) }),
  deleteDownload: (id: string) => request<DownloadItem>(`/downloads/${id}`, { method: "DELETE" }),

  listDebridAccounts: () => request<{ accounts: (DebridAccount & { apiKey: string })[] }>("/debrid-accounts"),
  addDebridAccount: (service: DebridService, apiKey: string) =>
    request(`/debrid-accounts`, { method: "POST", body: JSON.stringify({ service, apiKey }) }),
  removeDebridAccount: (service: DebridService) => request(`/debrid-accounts/${service}`, { method: "DELETE" }),

  listStorageTargets: () => request<{ targets: StorageTarget[] }>("/storage/targets"),
  getStorageUsage: () => request<{ targets: StorageTarget[] }>("/storage/usage"),
  addStorageTarget: (label: string, path: string) =>
    request<StorageTarget>("/storage/targets", { method: "POST", body: JSON.stringify({ label, path }) }),

  getSettings: () => request<Settings>("/settings"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  health: () => request<{ status: string; subsystems: Record<string, unknown> }>("/health"),
};
