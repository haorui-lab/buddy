// 标签整理工具：trim、去空、忽略大小写去重（保留首次出现的大小写与顺序）
export function normalizeTags(tags) {
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
