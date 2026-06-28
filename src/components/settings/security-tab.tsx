import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

import { describeBackend, usePrivacyStatus } from "@/services/privacy";
import { useT } from "@/i18n/use-t";

import { Section, TabContainer } from "./atoms";

export function SecurityTab() {
  const t = useT();
  const { status, loading, error } = usePrivacyStatus();

  return (
    <TabContainer>
      <Section title={t("security.credentials.title")}>
        {loading ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("security.credentials.loading")}
          </div>
        ) : error ? (
          <CredentialErrorBanner message={error} />
        ) : status?.available ? (
          <CredentialOkBanner backend={describeBackend(status)} />
        ) : (
          <CredentialPlainBanner backend={describeBackend(status)} />
        )}
      </Section>

      <Section title={t("security.privacy.title")}>
        <p className="text-xs text-muted-foreground">
          {t("security.privacy.results")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("security.privacy.credentials")}
        </p>
      </Section>
    </TabContainer>
  );
}

function CredentialOkBanner({ backend }: { backend: string }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
      <ShieldCheck className="mt-0.5 h-4 w-4 flex-none" />
      <div className="space-y-1">
        <div className="font-medium">{t("security.credentials.okTitle")}</div>
        <p>{t("security.credentials.okBody", { backend })}</p>
      </div>
    </div>
  );
}

function CredentialPlainBanner({ backend }: { backend: string }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-300/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" />
      <div className="space-y-1.5">
        <div className="font-medium">{t("security.credentials.plainTitle")}</div>
        <p>{t("security.credentials.plainBody", { backend })}</p>
      </div>
    </div>
  );
}

function CredentialErrorBanner({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" />
      <div className="space-y-1">
        <div className="font-medium">{t("security.credentials.errorTitle")}</div>
        <p className="break-all">{message}</p>
      </div>
    </div>
  );
}
