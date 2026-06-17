package download

import (
	"io"
	"time"
)

// ProgressFunc is called after each read with updated progress stats.
type ProgressFunc func(p Progress)

// Progress holds a snapshot of transfer progress.
type Progress struct {
	Bytes     int64         // bytes transferred so far
	Total     int64         // total bytes (-1 if unknown)
	Speed     float64       // current speed in bytes/sec (last interval)
	AvgSpeed  float64       // average speed in bytes/sec since start
	ETA       time.Duration // estimated time remaining; 0 if unknown
	Done      bool          // true when transfer is complete
}

// ProgressReader wraps an io.Reader and tracks transfer progress.
type ProgressReader struct {
	Reader     io.Reader
	Total      int64
	OnProgress ProgressFunc

	bytes     int64
	start     time.Time
	lastBytes int64
	lastTime  time.Time
}

func (r *ProgressReader) init() {
	now := time.Now()
	r.start = now
	r.lastTime = now
}

func (r *ProgressReader) Read(p []byte) (int, error) {
	if r.start.IsZero() {
		r.init()
	}

	n, err := r.Reader.Read(p)
	if n > 0 {
		r.bytes += int64(n)
		r.report(err == io.EOF)
	}
	return n, err
}

func (r *ProgressReader) report(done bool) {
	now := time.Now()

	elapsed := now.Sub(r.start).Seconds()
	var avgSpeed float64
	if elapsed > 0 {
		avgSpeed = float64(r.bytes) / elapsed
	}

	intervalSecs := now.Sub(r.lastTime).Seconds()
	var speed float64
	if intervalSecs > 0 {
		speed = float64(r.bytes-r.lastBytes) / intervalSecs
	}
	r.lastBytes = r.bytes
	r.lastTime = now

	var eta time.Duration
	if !done && avgSpeed > 0 && r.Total > 0 {
		remaining := float64(r.Total - r.bytes)
		eta = time.Duration(remaining/avgSpeed) * time.Second
	}

	r.OnProgress(Progress{
		Bytes:    r.bytes,
		Total:    r.Total,
		Speed:    speed,
		AvgSpeed: avgSpeed,
		ETA:      eta,
		Done:     done,
	})
}
