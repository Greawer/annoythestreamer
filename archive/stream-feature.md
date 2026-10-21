# Archived Stream Feature

This is a reference copy of the MediaMTX stream embed currently active in `app/page.tsx`. The active implementation is intentionally unchanged.

```tsx
<div ref={streamContainerRef} className="order-1 lg:order-2 md:order-1">
  <Card className="card-hover h-full flex flex-col">
    <CardHeader className="pb-2 sm:pb-3">
      <div className="flex items-center justify-between">
        <CardTitle className="text-base sm:text-lg">Stream</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleFullscreen}
          className="h-6 sm:h-8 text-[10px] sm:text-xs bg-transparent px-2"
        >
          <Maximize className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-1" />
          <span className="hidden sm:inline">Fullscreen</span>
        </Button>
      </div>
    </CardHeader>
    <CardContent className="p-2 sm:p-3 flex-1 min-h-0 flex items-center justify-center">
      <div
        ref={videoRef}
        className="relative w-full aspect-video bg-black rounded-lg flex items-center justify-center overflow-hidden border-2 border-slate-800/50 group"
      >
        <iframe
          src="http://localhost:8889/boo?videoLatencyHint=very-low"
          className="w-full h-full rounded-lg border-0 shadow-2xl"
          allow="camera *; microphone *; display-capture *; fullscreen *"
          title="AnnoyTheStreamer Live"
          loading="eager"
          onLoad={() => console.log("MediaMTX live!")}
        />
      </div>
    </CardContent>
  </Card>
</div>
```