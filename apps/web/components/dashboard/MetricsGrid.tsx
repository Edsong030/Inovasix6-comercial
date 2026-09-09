'use client';

import type { ComponentType } from 'react';
import { Card } from '@/components/ui/Card';
import {
  IconAgenda,
  IconLeads,
  IconTarget,
  IconTrend,
  type IconProps,
} from '@/components/ui/icons';
import type { Metric, MetricAccent } from '@/lib/mock/data';
import styles from './Dashboard.module.css';

/** Icon per KPI, keyed by the metric id from the mock data. */
const METRIC_ICON: Record<string, ComponentType<IconProps>> = {
  'new-leads': IconLeads,
  opportunities: IconTarget,
  meetings: IconAgenda,
  sales: IconTrend,
};

/** KPI row (4 headline cards). Values are mocked — no dashboard endpoint yet. */
export function MetricsGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div
      className={`${styles.grid} ${styles.metrics}`}
      role="list"
      aria-label="Indicadores do período"
    >
      {metrics.map((metric, index) => {
        const Icon = METRIC_ICON[metric.id] ?? IconTrend;
        return (
          <div role="listitem" key={metric.id} className="animateRise" data-index={index}>
            <Card interactive className={styles.metricCard}>
              <div className={styles.metric}>
                <span
                  className={styles.metricIcon}
                  data-accent={metric.accent satisfies MetricAccent}
                  aria-hidden="true"
                >
                  <Icon size={19} />
                </span>
                <div className={styles.metricInfo}>
                  <span className={styles.metricValue}>{metric.value}</span>
                  <p className={styles.metricLabel}>{metric.label}</p>
                  <span className={`${styles.metricDelta} ${styles[metric.trend]}`}>
                    {metric.trend === 'up' ? '↑ ' : metric.trend === 'down' ? '↓ ' : ''}
                    {metric.delta} {metric.hint}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </div>
  );
}
