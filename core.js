export const normalizeName = value => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");

export function calculateOvertimeMinutes(plannedValue, actualValue) {
  if (!plannedValue || !actualValue) return null;
  const difference = new Date(actualValue).getTime() - new Date(plannedValue).getTime();
  if (!Number.isFinite(difference)) return null;
  return Math.max(0, Math.round(difference / 60000));
}

export function markDeleted(entry, deletedAt, retentionDays = 30) {
  const deletedTime = new Date(deletedAt);
  return {
    ...entry,
    deleted_at: deletedTime.toISOString(),
    purge_after: new Date(deletedTime.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: deletedTime.toISOString(),
    sync_status: "pending"
  };
}

export function restoreDeleted(entry, restoredAt) {
  return {
    ...entry,
    deleted_at: null,
    purge_after: null,
    updated_at: new Date(restoredAt).toISOString(),
    sync_status: "pending"
  };
}

export function buildExportEnvelope(data, exportedAt, schemaVersion = "1.0.0") {
  return { schema_version: schemaVersion, exported_at: new Date(exportedAt).toISOString(), ...data };
}

function csvEscape(value) {
  const string = value == null ? "" : String(value);
  return /[",\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

export function buildCsv(headers, rows) {
  return "\ufeff" + [headers.map(csvEscape).join(","), ...rows.map(row => row.map(csvEscape).join(","))].join("\r\n");
}
