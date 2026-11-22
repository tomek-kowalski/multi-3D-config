import { CABINET_TYPE_ID } from "@/domain/modules/cabinetType";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import type { ModuleId } from "@/domain/modules/types";
import { useArrangementStore } from "./useArrangementStore";
import { useConfiguratorStore } from "./useConfiguratorStore";
import { usePreviewStore } from "./usePreviewStore";

type ArrangementStoreApi = typeof useArrangementStore;
type ConfiguratorStoreApi = typeof useConfiguratorStore;
type PreviewStoreApi = typeof usePreviewStore;

/**
 * Connects the existing cabinet configurator (its store and all its panels, unchanged) to the
 * arrangement. The arrangement is the source of truth; the cabinet store is the editing session of
 * the currently selected cabinet module:
 * - selecting a cabinet instance loads its configuration into the cabinet store;
 * - every committed cabinet edit is written back to that instance only.
 * Other modules are never touched, so every cabinet keeps its own independent configuration.
 */
export function bindCabinetSession(
  arrangementStore: ArrangementStoreApi = useArrangementStore,
  configuratorStore: ConfiguratorStoreApi = useConfiguratorStore,
  previewStore: PreviewStoreApi = usePreviewStore,
): () => void {
  let boundId: ModuleId | null = null;

  const selectedCabinet = () => {
    const { arrangement, selectedModuleId } = arrangementStore.getState();
    const instance = arrangement.modules.find((m) => m.id === selectedModuleId);
    return instance && instance.typeId === CABINET_TYPE_ID ? instance : null;
  };

  const load = () => {
    const instance = selectedCabinet();
    if (!instance) {
      if (boundId !== null) previewStore.getState().closeAll();
      boundId = null;
      return;
    }
    const configuration = instance.configuration as CabinetConfiguration;
    const switched = boundId !== instance.id;
    if (switched || configuratorStore.getState().configuration !== configuration) {
      boundId = instance.id;
      if (switched) previewStore.getState().closeAll();
      configuratorStore.getState().replaceConfiguration(configuration);
    }
  };

  const unsubscribeArrangement = arrangementStore.subscribe(load);
  const unsubscribeCabinet = configuratorStore.subscribe((state, previous) => {
    if (boundId === null || state.configuration === previous.configuration) return;
    const instance = arrangementStore.getState().arrangement.modules.find((m) => m.id === boundId);
    if (instance && instance.configuration !== state.configuration) {
      arrangementStore.getState().updateModuleConfiguration(boundId, state.configuration);
    }
  });
  load();
  return () => {
    unsubscribeArrangement();
    unsubscribeCabinet();
  };
}
