package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const homeAITestPeer = "100.90.1.2:8088"

func serveHomeAITest(t *testing.T, handler http.Handler) (*service, *fakeEngine) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	e := &fakeEngine{dial: func(ctx context.Context, network, target string) (net.Conn, error) {
		if network != "tcp" || target != homeAITestPeer {
			t.Errorf("dial %s %s", network, target)
			return nil, failure("invalid_target")
		}
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}}
	e.allow.Store(true)
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.stop)
	setHomeAITestPeer(s, true)
	return s, e
}

func setHomeAITestPeer(s *service, connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statusAt = time.Now()
	s.statusValue.Peers = []peerInfo{{IP: "100.90.1.2", Connected: connected}}
}

func TestHomeAIRequestOverSelectedPeer(t *testing.T) {
	data := bytes.Repeat([]byte{0x01, 0x92}, 128*1024)
	s, e := serveHomeAITest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Host != homeAITestPeer || r.URL.Path != homeAIUploadsPath+"/photo_1" ||
			r.URL.RawQuery != "offset=1024" || r.Header.Get("Authorization") != "Bearer homeinbox_test" ||
			r.Header.Get("Content-Type") != "application/octet-stream" || r.Header.Get("Accept-Encoding") != "" {
			t.Errorf("unexpected request %s %s %s", r.Method, r.Host, r.URL)
		}
		got, err := io.ReadAll(r.Body)
		if err != nil || !bytes.Equal(got, data) {
			t.Errorf("unexpected body: length=%d, error=%v", len(got), err)
		}
		w.Header().Set("Location", homeAIPath+"/assets")
		w.WriteHeader(http.StatusTemporaryRedirect)
		_, _ = w.Write([]byte{0, 255})
	}))
	raw, err := json.Marshal(homeAIRequest{
		Target: homeAITestPeer, Method: http.MethodPut, Path: homeAIUploadsPath + "/photo_1?offset=1024",
		Token: "homeinbox_test", ContentType: "application/octet-stream", Body: data,
	})
	if err != nil {
		t.Fatal(err)
	}
	pipe, feed := io.Pipe()
	defer feed.Close()
	responseReader, responseWriter := io.Pipe()
	defer responseReader.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer responseWriter.Close()
		serve(context.Background(), pipe, responseWriter, s)
	}()
	if err := json.NewEncoder(feed).Encode(request{ID: json.RawMessage("1"), Method: "homeai_request", Params: raw}); err != nil {
		t.Fatal(err)
	}
	var wire json.RawMessage
	err = json.NewDecoder(responseReader).Decode(&wire)
	if err != nil || string(wire) != `{"id":1,"result":{"status":307,"body":"AP8="}}` || e.dials.Load() != 1 {
		t.Fatalf("unexpected response or redirected request: %s %v (%d dials)", wire, err, e.dials.Load())
	}
	feed.Close()
	<-done
}

func TestHomeAIRouteValidation(t *testing.T) {
	tests := []struct {
		method, path, token string
		valid               bool
	}{
		{"POST", "/api/auth/platform/challenge", "", true},
		{"POST", "/api/auth/platform/exchange", "", true},
		{"GET", homeAIPath + "/assets?q=%E7%85%A7%E7%89%87&limit=100", "session", true},
		{"GET", homeAIPath + "/space-destination/folders?parent=", "session", true},
		{"GET", homeAIUploadsPath + "/photo_1", "homeinbox_test", true},
		{"POST", homeAIUploadsPath + "/photo_1/complete", "homeinbox_test", true},
		{"POST", homeAIUploadsPath, "homeinbox_test", true},
		{"GET", "/api/auth/platform/challenge", "", false},
		{"POST", "/api/auth/platform/challenge", "session", false},
		{"GET", "http://100.90.1.2:8088" + homeAIPath + "/assets", "session", false},
		{"GET", "/api/services/wanx.media/v1/jobs", "session", false},
		{"GET", homeAIPath + "/../homeai/assets", "session", false},
		{"GET", homeAIPath + "/uploads%2Fphoto_1", "homeinbox_test", false},
		{"GET", homeAIPath + "/assets?access_token=untrusted", "session", false},
		{"GET", homeAIPath + "/assets?q=a&q=b", "session", false},
		{"GET", homeAIPath + "/assets?q=a#b", "session", false},
		{"GET", homeAIPath + "/assets", "homeinbox_test", false},
		{"POST", homeAIPath + "/inbox-grants", "homeinbox_test", false},
		{"DELETE", homeAIUploadsPath + "/photo_1", "homeinbox_test", false},
		{"DELETE", homeAIUploadsPath + "/photo_1", "session", true},
		{"PUT", homeAIUploadsPath + "/photo_1?offset=2&offset=3", "homeinbox_test", false},
		{"GET", homeAIPath + "/assets", "session\r\nX-Evil: yes", false},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			_, err := (homeAIRequest{Method: tt.method, Path: tt.path, Token: tt.token}).route()
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, result=%v", tt.valid, err)
			}
		})
	}
	for _, target := range []string{"127.0.0.1:8088", "192.168.0.102:8088", "100.90.1.2:443", "[::ffff:100.90.1.2]:8088", "100.90.1.2:08088"} {
		if _, err := (homeAIRequest{Target: target}).validatedTarget(); err == nil {
			t.Errorf("accepted non-P2P target %q", target)
		}
	}
}

func TestHomeAIRequestRequiresConnectedAndAllowedPeer(t *testing.T) {
	s, e := serveHomeAITest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("untrusted peer was dialed")
	}))
	p := homeAIRequest{Target: homeAITestPeer, Method: http.MethodGet, Path: homeAIPath + "/assets", Token: "session"}
	setHomeAITestPeer(s, false)
	if _, err := s.requestHomeAI(context.Background(), p); err == nil || err.Error() != "peer_unavailable" {
		t.Fatal(err)
	}
	setHomeAITestPeer(s, true)
	e.allow.Store(false)
	if _, err := s.requestHomeAI(context.Background(), p); err == nil || e.dials.Load() != 0 {
		t.Fatal(err)
	}
}

func TestHomeAIRequestCancelsOnEngineRecovery(t *testing.T) {
	entered, released := make(chan struct{}), make(chan struct{})
	s, _ := serveHomeAITest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(released)
	}))
	complete := make(chan error, 1)
	go func() {
		_, err := s.requestHomeAI(context.Background(), homeAIRequest{
			Target: homeAITestPeer, Method: http.MethodGet, Path: homeAIPath + "/assets", Token: "session",
		})
		complete <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("request never reached the first engine")
	}
	if _, err := s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-complete:
		if err == nil {
			t.Fatal("data from the retired engine was accepted")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request was not cancelled")
	}
	select {
	case <-released:
	case <-time.After(3 * time.Second):
		t.Fatal("connection to the retired engine was not closed")
	}
}

func TestHomeAIResponseSizeIsBounded(t *testing.T) {
	s, _ := serveHomeAITest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "20971520")
		w.WriteHeader(http.StatusOK)
	}))
	_, err := s.requestHomeAI(context.Background(), homeAIRequest{
		Target: homeAITestPeer, Method: http.MethodGet, Path: homeAIPath + "/assets", Token: "session",
	})
	if err == nil || err.Error() != "response_too_large" {
		t.Fatal(err)
	}
}
