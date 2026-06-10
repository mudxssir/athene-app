export default function WatchlistsLoading() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full animate-pulse">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-8 w-48 rounded-xl bg-muted" />
          <div className="h-4 w-72 rounded-lg bg-muted" />
        </div>
        <div className="h-11 w-36 rounded-2xl bg-muted" />
      </div>
      <div className="grid gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 rounded-2xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
