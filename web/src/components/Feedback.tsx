/**
 * 骨架屏。
 *
 * 用它替换「加载中…」这行字：内容位置提前占住，数据到了不会跳一下，
 * 用户也能看出这块将来会有什么。
 */

export function SkeletonCard({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="card skeleton-card" key={i}>
          <div className="skeleton skeleton-poster" />
          <div className="skeleton skeleton-line" style={{ width: '80%' }} />
          <div className="skeleton skeleton-line" style={{ width: '50%' }} />
        </div>
      ))}
    </>
  );
}

export function SkeletonRow({ count = 7 }: { count?: number }) {
  return (
    <div className="row">
      <SkeletonCard count={count} />
    </div>
  );
}

export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid-cards">
      <SkeletonCard count={count} />
    </div>
  );
}

/**
 * 错误提示条。
 *
 * 三件事：说清楚发生了什么、给一个重试按钮、有旧数据的时候不要盖住旧数据。
 */
export function ErrorNotice({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={'notice' + (compact ? ' notice-compact' : '')}>
      <span>{message}</span>
      {onRetry && (
        <button className="btn" onClick={onRetry} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }}>
          重试
        </button>
      )}
    </div>
  );
}

/**
 * 上游部分失败时的提示。
 *
 * 搜索打了十几个源，挂掉两三个是常态 —— 这时候页面不该报错，
 * 只是说明一下有几家没取到，内容照常展示。
 */
export function PartialNotice({ failed, total }: { failed: number; total: number }) {
  if (failed <= 0) return null;
  return (
    <div className="notice notice-soft">
      <span>{total} 个来源里有 {failed} 个暂时取不到数据，下面显示的是其余来源的结果</span>
    </div>
  );
}
