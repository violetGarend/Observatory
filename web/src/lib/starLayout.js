const GROUP_ORDER = ['user', 'project', 'plugin'];
const GROUP_LABEL = {
  user: '用户技能',
  project: '项目技能',
  plugin: '插件技能',
};

/**
 * 星图布局：按安装来源分扇区，扇区内按 tokensHigh 降序填同心环。
 * 节点圆半径 r = k·√tokensHigh，因此面积严格 ∝ tokensHigh。
 * 位置只负责分组与避让，不编码成本。
 */
export function layoutStarMap(
  skills = [],
  { width = 860, height = 460, k = 0.4, rMin = 64, rMax = 170, ringStep = 17, slotArc = 20 } = {}
) {
  const cx = width / 2;
  const cy = height / 2;

  const groups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABEL[key],
    skills: skills
      .filter((s) => s.sourceType === key)
      .sort((a, b) => b.tokensHigh - a.tokensHigh || a.name.localeCompare(b.name)),
  })).filter((g) => g.skills.length > 0);

  const total = groups.reduce((n, g) => n + g.skills.length, 0);
  if (!total) return { nodes: [], sectors: [], center: { x: cx, y: cy }, width, height };

  const usable = Math.PI * 2 * (336 / 360);
  const gap = (Math.PI * 2 * 12) / 360;
  const weightSum = groups.reduce((n, g) => n + Math.sqrt(g.skills.length), 0);

  const nodes = [];
  const sectors = [];
  let cursor = -Math.PI / 2; // 从正上方开始，顺时针

  for (const group of groups) {
    const span = (usable * Math.sqrt(group.skills.length)) / weightSum;
    const start = cursor;
    const end = cursor + span;
    cursor = end + gap;

    sectors.push({
      key: group.key,
      label: group.label,
      count: group.skills.length,
      startAngle: start,
      endAngle: end,
      rInner: rMin - 14,
      rOuter: rMax + 12,
    });

    // 从外环往内环填，外环槽位多
    let index = 0;
    for (let ring = 0; ring < 7 && index < group.skills.length; ring++) {
      const radius = rMax - ring * ringStep;
      if (radius < rMin) break;
      const slots = Math.max(1, Math.floor((span * radius) / slotArc));
      const take = Math.min(slots, group.skills.length - index);

      for (let i = 0; i < take; i++, index++) {
        const skill = group.skills[index];
        const angle = start + (span * (i + 0.5)) / take;
        nodes.push({
          ...skill,
          angle,
          ring,
          radius,
          r: k * Math.sqrt(Math.max(0, skill.tokensHigh || 0)),
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle),
        });
      }
    }

    // 极端情况下槽位不足：剩余节点放到最内环，均分角度
    if (index < group.skills.length) {
      const radius = rMin + 6;
      const rest = group.skills.length - index;
      for (let i = 0; i < rest; i++, index++) {
        const skill = group.skills[index];
        const angle = start + (span * (i + 0.5)) / rest;
        nodes.push({
          ...skill,
          angle,
          ring: 7,
          radius,
          r: k * Math.sqrt(Math.max(0, skill.tokensHigh || 0)),
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle),
        });
      }
    }
  }

  return { nodes, sectors, center: { x: cx, y: cy }, width, height };
}

/** 环形扇区路径 */
export function sectorPath(cx, cy, rIn, rOut, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rOut, a0);
  const [x1, y1] = pt(rOut, a1);
  const [x2, y2] = pt(rIn, a1);
  const [x3, y3] = pt(rIn, a0);

  return [
    `M${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A${rOut} ${rOut} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `A${rIn} ${rIn} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    'Z',
  ].join(' ');
}
