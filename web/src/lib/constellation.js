import { fullNumber, relative } from './format.js';

export function formatTokensRange(low, high) {
  return `${fullNumber(low)}–${fullNumber(high)}`;
}

export const CONFIDENCE_META = {
  low: { label: '低', tone: 'low', hint: '< 20 次事件，样本不足以做时序结论' },
  medium: { label: '中', tone: 'medium', hint: '20–99 次事件' },
  high: { label: '高', tone: 'high', hint: '≥ 100 次事件' },
};

export function confidenceMeta(conf) {
  return CONFIDENCE_META[conf] || CONFIDENCE_META.low;
}

export function lastUsedText(ts) {
  return ts ? relative(ts) : '—';
}

export function mentionText(skill) {
  if (!skill.mentionTracked) return '未知';
  return `${skill.mentionStrong} / ${skill.mentionWeak}`;
}

export function sourceText(skill) {
  return skill.source || (skill.sourceType === 'plugin' ? '插件' : '用户');
}
