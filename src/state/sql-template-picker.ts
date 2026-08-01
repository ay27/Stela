import { create } from "zustand";

interface SqlTemplatePickerState {
  open: boolean;
  onSelect: ((sql: string) => void) | null;
  openPicker: (onSelect: (sql: string) => void) => void;
  select: (sql: string) => void;
  close: () => void;
}

export const useSqlTemplatePicker = create<SqlTemplatePickerState>((set, get) => ({
  open: false,
  onSelect: null,
  openPicker: (onSelect) => set({ open: true, onSelect }),
  select: (sql) => {
    const onSelect = get().onSelect;
    set({ open: false, onSelect: null });
    if (import.meta.env?.DEV) {
      console.info("[stela][sql-template] picker selected", {
        hadCallback: onSelect !== null,
        sqlLength: sql.length,
      });
    }
    onSelect?.(sql);
  },
  close: () => set({ open: false, onSelect: null }),
}));

export function openSqlTemplatePicker(onSelect: (sql: string) => void): void {
  useSqlTemplatePicker.getState().openPicker(onSelect);
}
