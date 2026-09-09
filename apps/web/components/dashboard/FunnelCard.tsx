import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { FUNNEL_CONVERSION, type FunnelStage } from '@/lib/mock/data';
import styles from './Dashboard.module.css';

/** Circular conversion gauge, drawn with SVG (no chart library). */
function ConversionGauge({ rate }: { rate: number }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const dash = (rate / 100) * circumference;

  return (
    <div className={styles.gauge}>
      <svg viewBox="0 0 120 120" className={styles.gaugeSvg} role="img" aria-label={`Taxa de conversão: ${rate}%`}>
        <defs>
          <linearGradient id="funnelGauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0087ff" />
            <stop offset="55%" stopColor="#782cff" />
            <stop offset="100%" stopColor="#b026ff" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={radius} className={styles.gaugeTrack} />
        <circle
          cx="60"
          cy="60"
          r={radius}
          className={styles.gaugeFill}
          stroke="url(#funnelGauge)"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="66" className={styles.gaugeValue} textAnchor="middle">
          {rate}%
        </text>
      </svg>
      <p className={styles.gaugeCaption}>Taxa de conversão</p>
      <p className={styles.gaugeDelta}>↑ {FUNNEL_CONVERSION.deltaLabel}</p>
      <p className={styles.gaugeOpp}>{FUNNEL_CONVERSION.opportunities}</p>
      <p className={styles.gaugeOppLabel}>Valor em oportunidades</p>
    </div>
  );
}

export function FunnelCard({ stages }: { stages: FunnelStage[] }) {
  return (
    <Card ariaLabel="Funil comercial">
      <CardHeader
        title="Funil Comercial"
        subtitle="Do primeiro contato ao cliente. Acompanhe sua evolução em tempo real."
        actions={<Badge tone="neutral">Este mês</Badge>}
      />
      <CardBody>
        <div className={styles.funnelLayout}>
          <div className={styles.funnel}>
            {stages.map((stage, index) => (
              <div className={styles.stage} key={stage.id} data-stage={index}>
                <span className={styles.stageLabel}>{stage.label}</span>
                <div
                  className={styles.stageTrack}
                  role="meter"
                  aria-label={`${stage.label}: ${stage.count} leads (${stage.percent}%)`}
                  aria-valuenow={stage.count}
                  aria-valuemin={0}
                  aria-valuemax={stages[0]?.count ?? stage.count}
                >
                  <div className={styles.stageFill} style={{ width: `${stage.percent}%` }} />
                </div>
                <span className={styles.stageCount}>{stage.count}</span>
                <span className={styles.stagePercent}>{stage.percent}%</span>
              </div>
            ))}
          </div>
          <ConversionGauge rate={FUNNEL_CONVERSION.rate} />
        </div>
      </CardBody>
    </Card>
  );
}
