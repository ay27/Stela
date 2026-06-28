/** Crepe list-item 任务列表图标：16×16 viewBox，由 CSS 缩到 14px 并着色。 */

/** 无序列表圆点：viewBox 紧贴圆心，避免 Crepe 默认 24px 画布缩放后只剩 1–2px。 */
export const LIST_BULLET_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
  <circle cx="4" cy="4" r="2.5" fill="currentColor"/>
</svg>`;

export const LIST_CHECKBOX_UNCHECKED_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.25"/>
</svg>`;

export const LIST_CHECKBOX_CHECKED_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor"/>
  <path d="M4.2 8.1 6.5 10.4 11.8 5.1" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
