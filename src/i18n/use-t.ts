import { useTranslation } from "react-i18next";

export function useT() {
  return useTranslation().t;
}
