"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/configurator/ConfirmDialog";
import { useT } from "@/i18n";
import { startNewConfiguration } from "@/services/sharing";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass } from "@/components/ui/fields";
import { ShareDialog } from "./ShareDialog";

/**
 * "Nowa konfiguracja" and "Udostępnij konfigurację". A new configuration asks for confirmation when the
 * current one has unsaved changes; saved quotations, shared links and the shop cart are not touched.
 */
export function WorkspaceActions() {
  const t = useT();
  const hydrated = useArrangementStore((s) => s.hydrated);
  const [confirming, setConfirming] = useState(false);
  const [sharing, setSharing] = useState(false);

  const startNew = () => {
    setConfirming(false);
    startNewConfiguration();
    useArrangementStore.getState().setNotice([{ code: "workspace_started" }]);
  };

  return (
    <div className="grid grid-cols-2 gap-2" data-workspace-actions>
      <button
        type="button"
        className={buttonClass}
        disabled={!hydrated}
        onClick={() => (useArrangementStore.getState().isDirty() ? setConfirming(true) : startNew())}
      >
        {t("workspace.new")}
      </button>
      <button type="button" className={buttonClass} disabled={!hydrated} onClick={() => setSharing(true)}>
        {t("share.action")}
      </button>
      <ConfirmDialog
        open={confirming}
        title={t("workspace.newConfirmTitle")}
        confirmLabel={t("workspace.newConfirm")}
        onConfirm={startNew}
        onCancel={() => setConfirming(false)}
      >
        {t("workspace.newConfirmBody")}
      </ConfirmDialog>
      {sharing && <ShareDialog onClose={() => setSharing(false)} />}
    </div>
  );
}
