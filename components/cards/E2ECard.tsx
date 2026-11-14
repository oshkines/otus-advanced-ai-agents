import type { ReactElement } from "react";

import { BentoCard } from "@/components/bento/BentoCard";
import { Metric } from "@/components/bento/Metric";
import type { OrchestratorConfig } from "@/lib/orchestrator/types";

export interface E2ECardProps {
  readonly config: OrchestratorConfig;
}

/** e2e-контур: раннер, скрипт и путь скриншота + путь legacy-панели C++ ядра. */
export function E2ECard({ config }: E2ECardProps): ReactElement {
  const e2e = config.e2e;

  return (
    <BentoCard
      testId="e2e-card"
      title="E2E / UI"
      subtitle="Playwright for Python, без Node-тестов"
      className="col-span-12 lg:col-span-6"
      footer="Доказательства: .planning/screenshots/"
    >
      <Metric label="Runner" value={e2e?.runner ?? "python-playwright"} mono />
      <Metric label="Test script" value={e2e?.test_script ?? "tests/browser_test.py"} mono />
      <Metric label="Скриншот" value={e2e?.screenshot ?? "—"} mono />
      <Metric label="Status panel (core)" value={config.ui.status_panel} mono />
    </BentoCard>
  );
}
