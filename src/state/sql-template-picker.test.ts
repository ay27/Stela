import {
  openSqlTemplatePicker,
  useSqlTemplatePicker,
} from "./sql-template-picker";

let selected: string | null = null;
openSqlTemplatePicker((sql) => {
  selected = sql;
});

if (!useSqlTemplatePicker.getState().open) {
  throw new Error("picker should open");
}

useSqlTemplatePicker.getState().select("SELECT 1");
if (selected !== "SELECT 1" || useSqlTemplatePicker.getState().open) {
  throw new Error("picker should close and deliver SQL synchronously");
}

console.log("sql-template-picker state test passed");
