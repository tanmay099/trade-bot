import { useState, useEffect } from 'react';

// Terminal-inspired minimal trading dashboard
export default function TradingDashboard() {
  const [data, setData] = useState({
    status: null,
    box: null,
    trades: null,
    currentTrade: null,
    ticker: null,
    loading: true,
    error: null
  });

  const [lastUpdate, setLastUpdate] = useState(new Date());

  // Fetch all data
  const fetchAllData = async () => {
    try {
      const [statusRes, boxRes, tradesRes, currentRes, tickerRes] = await Promise.allSettled([
        fetch('/status').then(r => r.json()),
        fetch('/box').then(r => r.json()),
        fetch('/trades/today').then(r => r.json()),
        fetch('/current-trade').then(r => r.json()),
        fetch('/ticker/status').then(r => r.json())
      ]);
consl
      setData({
        status: statusRes.status === 'fulfilled' ? statusRes.value : null,
        box: boxRes.status === 'fulfilled' ? boxRes.value : null,
        trades: tradesRes.status === 'fulfilled' ? tradesRes.value : null,
        currentTrade: currentRes.status === 'fulfilled' ? currentRes.value : null,
        ticker: tickerRes.status === 'fulfilled' ? tickerRes.value : null,
        loading: false,
        error: null
      });
      setLastUpdate(new Date());
    } catch (err) {
      setData(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date) => {
    return new Date(date).toLocaleTimeString('en-IN', { hour12: false });
  };

  const formatPrice = (price) => {
    if (price == null) return '—';
    return `₹${Number(price).toFixed(2)}`;
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>◈</span>
          <span style={styles.logoText}>NIFTY BREAKOUT</span>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.updateTime}>
            {lastUpdate.toLocaleTimeString('en-IN', { hour12: false })}
          </span>
          <button onClick={fetchAllData} style={styles.refreshBtn}>↻</button>
        </div>
      </header>

      {/* Status Bar */}
      <div style={styles.statusBar}>
        <StatusIndicator 
          label="ENGINE" 
          active={data.status?.engineRunning} 
        />
        <StatusIndicator 
          label="TICKER" 
          active={data.ticker?.connected} 
        />
        <StatusIndicator 
          label="SESSION" 
          active={data.status?.accessTokenSet} 
        />
      </div>

      {/* Main Grid */}
      <div style={styles.grid}>
        {/* Box Card */}
        <Card title="TODAY'S BOX" icon="□">
          {data.box?.boxHigh ? (
            <div style={styles.boxContent}>
              <div style={styles.boxRow}>
                <span style={styles.boxLabel}>HIGH</span>
                <span style={{...styles.boxValue, color: '#00ff9d'}}>{formatPrice(data.box.boxHigh)}</span>
              </div>
              <div style={styles.boxDivider} />
              <div style={styles.boxRow}>
                <span style={styles.boxLabel}>LOW</span>
                <span style={{...styles.boxValue, color: '#ff6b6b'}}>{formatPrice(data.box.boxLow)}</span>
              </div>
              <div style={styles.boxMeta}>
                {data.box.start} → {data.box.end}
              </div>
            </div>
          ) : (
            <div style={styles.empty}>Not computed yet</div>
          )}
        </Card>

        {/* Current Trade Card */}
        <Card title="ACTIVE TRADE" icon="●">
          {data.currentTrade?.trade ? (
            <div style={styles.tradeContent}>
              <div style={styles.tradeHeader}>
                <span style={{
                  ...styles.signal,
                  background: data.currentTrade.trade.signal === 'BULL' ? '#00ff9d20' : '#ff6b6b20',
                  color: data.currentTrade.trade.signal === 'BULL' ? '#00ff9d' : '#ff6b6b'
                }}>
                  {data.currentTrade.trade.signal}
                </span>
                <span style={styles.tradeSymbol}>{data.currentTrade.trade.tradingsymbol}</span>
              </div>
              <div style={styles.tradeGrid}>
                <TradeMetric label="ENTRY" value={formatPrice(data.currentTrade.trade.entryPrice)} />
                <TradeMetric label="SL" value={formatPrice(data.currentTrade.trade.stopLoss)} color="#ff6b6b" />
                <TradeMetric label="TARGET" value={formatPrice(data.currentTrade.trade.target)} color="#00ff9d" />
                <TradeMetric label="QTY" value={data.currentTrade.trade.quantity} />
              </div>
            </div>
          ) : (
            <div style={styles.empty}>No active trade</div>
          )}
        </Card>

        {/* Ticker Card */}
        <Card title="TICKER STATUS" icon="⚡">
          {data.ticker ? (
            <div style={styles.tickerContent}>
              <div style={styles.tickerMain}>
                <span style={{
                  ...styles.tickerStatus,
                  color: data.ticker.connected ? '#00ff9d' : '#ff6b6b'
                }}>
                  {data.ticker.connected ? 'STREAMING' : 'DISCONNECTED'}
                </span>
              </div>
              <div style={styles.tickerMeta}>
                <span>{data.ticker.subscriptions || 0} subscriptions</span>
              </div>
            </div>
          ) : (
            <div style={styles.empty}>Not initialized</div>
          )}
        </Card>

        {/* Config Card */}
        <Card title="CONFIG" icon="⚙">
          {data.status?.config ? (
            <div style={styles.configContent}>
              <ConfigRow label="INDEX" value={data.status.config.indexSymbol} />
              <ConfigRow label="INTERVAL" value={data.status.config.interval} />
              <ConfigRow label="CLOSE" value={data.status.config.marketCloseTime} />
              <ConfigRow label="TRAIL" value={`${data.status.config.trailingStopLoss?.profitThreshold}→${data.status.config.trailingStopLoss?.newSLDistance}`} />
            </div>
          ) : (
            <div style={styles.empty}>Loading...</div>
          )}
        </Card>
      </div>

      {/* Trades Table */}
      <div style={styles.tradesSection}>
        <div style={styles.tradesHeader}>
          <span style={styles.tradesTitle}>◇ TODAY'S TRADES</span>
          <span style={styles.tradesCount}>{data.trades?.count || 0}</span>
        </div>
        {data.trades?.trades?.length > 0 ? (
          <div style={styles.tradesTable}>
            <div style={styles.tableHeader}>
              <span>TIME</span>
              <span>SIGNAL</span>
              <span>SYMBOL</span>
              <span>ENTRY</span>
              <span>EXIT</span>
              <span>P/L</span>
              <span>REASON</span>
            </div>
            {data.trades.trades.map((trade, i) => (
              <div key={i} style={styles.tableRow}>
                <span style={styles.tableCell}>{trade.entryTime?.slice(0,5) || '—'}</span>
                <span style={{
                  ...styles.tableCell,
                  color: trade.signal === 'BULL' ? '#00ff9d' : '#ff6b6b'
                }}>{trade.signal}</span>
                <span style={styles.tableCell}>{trade.tradingsymbol?.slice(-12) || '—'}</span>
                <span style={styles.tableCell}>{formatPrice(trade.entryPrice)}</span>
                <span style={styles.tableCell}>{formatPrice(trade.exitPrice)}</span>
                <span style={{
                  ...styles.tableCell,
                  color: (trade.pnl || 0) >= 0 ? '#00ff9d' : '#ff6b6b'
                }}>
                  {trade.pnl != null ? `${trade.pnl >= 0 ? '+' : ''}${formatPrice(trade.pnl)}` : '—'}
                </span>
                <span style={{
                  ...styles.tableCell,
                  ...styles.reason,
                  background: trade.exitReason === 'TARGET' ? '#00ff9d15' : 
                              trade.exitReason === 'SL' ? '#ff6b6b15' : '#ffffff10'
                }}>{trade.exitReason || 'OPEN'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={styles.emptyTrades}>No trades today</div>
        )}
      </div>

      {/* Footer */}
      <footer style={styles.footer}>
        <span>WebSocket Ticker Mode</span>
        <span>•</span>
        <span>Auto-refresh: 5s</span>
      </footer>
    </div>
  );
}

// Components
function StatusIndicator({ label, active }) {
  return (
    <div style={styles.statusItem}>
      <span style={{
        ...styles.statusDot,
        background: active ? '#00ff9d' : '#ff6b6b',
        boxShadow: active ? '0 0 8px #00ff9d' : '0 0 8px #ff6b6b'
      }} />
      <span style={styles.statusLabel}>{label}</span>
    </div>
  );
}

function Card({ title, icon, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <span style={styles.cardIcon}>{icon}</span>
        <span style={styles.cardTitle}>{title}</span>
      </div>
      <div style={styles.cardContent}>{children}</div>
    </div>
  );
}

function TradeMetric({ label, value, color }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={{...styles.metricValue, color: color || '#fff'}}>{value}</span>
    </div>
  );
}

function ConfigRow({ label, value }) {
  return (
    <div style={styles.configRow}>
      <span style={styles.configLabel}>{label}</span>
      <span style={styles.configValue}>{value}</span>
    </div>
  );
}

// Styles
const styles = {
  container: {
    minHeight: '100vh',
    background: '#0a0a0f',
    color: '#e0e0e0',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    padding: '20px',
    boxSizing: 'border-box'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
    paddingBottom: '16px',
    borderBottom: '1px solid #1a1a2e'
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  logoIcon: {
    fontSize: '24px',
    color: '#00ff9d'
  },
  logoText: {
    fontSize: '18px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#fff'
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  updateTime: {
    fontSize: '12px',
    color: '#666',
    fontFamily: 'inherit'
  },
  refreshBtn: {
    background: '#1a1a2e',
    border: '1px solid #2a2a4e',
    color: '#888',
    width: '32px',
    height: '32px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '16px',
    transition: 'all 0.2s'
  },
  statusBar: {
    display: 'flex',
    gap: '24px',
    marginBottom: '24px',
    padding: '12px 16px',
    background: '#0f0f18',
    borderRadius: '8px',
    border: '1px solid #1a1a2e'
  },
  statusItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    transition: 'all 0.3s'
  },
  statusLabel: {
    fontSize: '11px',
    fontWeight: '500',
    letterSpacing: '1px',
    color: '#888'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '16px',
    marginBottom: '24px'
  },
  card: {
    background: '#0f0f18',
    border: '1px solid #1a1a2e',
    borderRadius: '12px',
    overflow: 'hidden'
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: '1px solid #1a1a2e',
    background: '#0a0a12'
  },
  cardIcon: {
    color: '#00ff9d',
    fontSize: '12px'
  },
  cardTitle: {
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '1.5px',
    color: '#888'
  },
  cardContent: {
    padding: '16px'
  },
  empty: {
    color: '#444',
    fontSize: '12px',
    textAlign: 'center',
    padding: '20px 0'
  },
  boxContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  boxRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  boxLabel: {
    fontSize: '11px',
    color: '#666',
    letterSpacing: '1px'
  },
  boxValue: {
    fontSize: '18px',
    fontWeight: '600',
    fontFamily: 'inherit'
  },
  boxDivider: {
    height: '1px',
    background: '#1a1a2e',
    margin: '4px 0'
  },
  boxMeta: {
    fontSize: '10px',
    color: '#444',
    marginTop: '8px',
    textAlign: 'center'
  },
  tradeContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  },
  tradeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  },
  signal: {
    fontSize: '10px',
    fontWeight: '600',
    padding: '4px 8px',
    borderRadius: '4px',
    letterSpacing: '1px'
  },
  tradeSymbol: {
    fontSize: '11px',
    color: '#888',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  tradeGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px'
  },
  metric: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px'
  },
  metricLabel: {
    fontSize: '9px',
    color: '#555',
    letterSpacing: '0.5px'
  },
  metricValue: {
    fontSize: '14px',
    fontWeight: '500'
  },
  tickerContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    alignItems: 'center',
    padding: '8px 0'
  },
  tickerMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  tickerStatus: {
    fontSize: '14px',
    fontWeight: '600',
    letterSpacing: '2px'
  },
  tickerMeta: {
    fontSize: '11px',
    color: '#555'
  },
  configContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  configRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  configLabel: {
    fontSize: '10px',
    color: '#555',
    letterSpacing: '0.5px'
  },
  configValue: {
    fontSize: '12px',
    color: '#aaa'
  },
  tradesSection: {
    background: '#0f0f18',
    border: '1px solid #1a1a2e',
    borderRadius: '12px',
    overflow: 'hidden',
    marginBottom: '24px'
  },
  tradesHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #1a1a2e',
    background: '#0a0a12'
  },
  tradesTitle: {
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '1.5px',
    color: '#888'
  },
  tradesCount: {
    fontSize: '12px',
    color: '#00ff9d',
    background: '#00ff9d15',
    padding: '2px 8px',
    borderRadius: '4px'
  },
  tradesTable: {
    overflowX: 'auto'
  },
  tableHeader: {
    display: 'grid',
    gridTemplateColumns: '60px 60px 1fr 80px 80px 80px 70px',
    gap: '8px',
    padding: '10px 16px',
    background: '#0a0a12',
    fontSize: '9px',
    color: '#555',
    letterSpacing: '1px',
    fontWeight: '600'
  },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: '60px 60px 1fr 80px 80px 80px 70px',
    gap: '8px',
    padding: '10px 16px',
    borderBottom: '1px solid #1a1a2e',
    fontSize: '12px',
    alignItems: 'center'
  },
  tableCell: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  reason: {
    fontSize: '9px',
    padding: '3px 6px',
    borderRadius: '3px',
    textAlign: 'center',
    letterSpacing: '0.5px'
  },
  emptyTrades: {
    padding: '40px',
    textAlign: 'center',
    color: '#444',
    fontSize: '12px'
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    gap: '12px',
    fontSize: '10px',
    color: '#444',
    padding: '16px'
  }
};
