import { AppShell } from "@/layout/AppShell";
import { ThemeProvider } from "@/components/theme-provider";
import { StelaI18nProvider } from "@/i18n/context";

export default function App() {
  return (
    <StelaI18nProvider>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </StelaI18nProvider>
  );
}
