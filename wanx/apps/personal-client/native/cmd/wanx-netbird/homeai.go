package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	homeAIPath            = "/api/services/wanx.homeai/v1"
	homeAIUploadsPath     = homeAIPath + "/uploads"
	maxHomeAIRequestBody  = 2 * 1024 * 1024
	maxHomeAIResponseBody = 18 * 1024 * 1024
)

var (
	netBirdIPv4        = netip.MustParsePrefix("100.64.0.0/10")
	homeAIResourcePath = regexp.MustCompile(`^/api/services/wanx[.]homeai/v1(/[A-Za-z0-9_-]{1,128})+$`)
	homeAIUploadID     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	homeAIBearer       = regexp.MustCompile(`^[A-Za-z0-9_.~+/=-]+$`)
)

type homeAIRequest struct {
	Target      string `json:"target"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Token       string `json:"token"`
	ContentType string `json:"contentType"`
	Body        []byte `json:"body"`
}

type homeAIResponse struct {
	Status int    `json:"status"`
	Body   []byte `json:"body"`
}

func (p homeAIRequest) validatedTarget() (netip.Addr, error) {
	target, err := netip.ParseAddrPort(p.Target)
	if err != nil || target.Port() != 8088 || !netBirdIPv4.Contains(target.Addr()) || target.String() != p.Target {
		return netip.Addr{}, failure("invalid_target")
	}
	return target.Addr(), nil
}

func (p homeAIRequest) route() (*url.URL, error) {
	if len(p.Path) > 8192 || len(p.Body) > maxHomeAIRequestBody {
		return nil, failure("invalid_params")
	}
	path, err := url.ParseRequestURI(p.Path)
	if err != nil || path.IsAbs() || path.Host != "" || path.RawPath != "" || path.ForceQuery || strings.Contains(p.Path, "#") {
		return nil, failure("invalid_path")
	}
	if p.ContentType != "" && p.ContentType != "application/json" && p.ContentType != "application/octet-stream" {
		return nil, failure("invalid_params")
	}
	switch path.Path {
	case "/api/auth/platform/challenge", "/api/auth/platform/exchange":
		if p.Method != http.MethodPost || p.Token != "" || path.RawQuery != "" {
			return nil, failure("invalid_path")
		}
	default:
		if !homeAIResourcePath.MatchString(path.Path) || len(p.Token) > 16384 || !homeAIBearer.MatchString(p.Token) {
			return nil, failure("invalid_path")
		}
		switch p.Method {
		case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			return nil, failure("invalid_method")
		}
		if strings.HasPrefix(p.Token, "homeinbox_") && !isHomeAIUpload(p.Method, path.Path) {
			return nil, failure("invalid_path")
		}
	}
	if err := validateHomeAIQuery(p.Method, path); err != nil {
		return nil, err
	}
	return path, nil
}

func isHomeAIUpload(method, path string) bool {
	if path == homeAIUploadsPath {
		return method == http.MethodPost
	}
	tail, ok := strings.CutPrefix(path, homeAIUploadsPath+"/")
	if !ok {
		return false
	}
	id, suffix, hasSuffix := strings.Cut(tail, "/")
	if !homeAIUploadID.MatchString(id) {
		return false
	}
	if hasSuffix {
		return method == http.MethodPost && suffix == "complete"
	}
	return method == http.MethodGet || method == http.MethodPut
}

func validateHomeAIQuery(method string, path *url.URL) error {
	params, err := url.ParseQuery(path.RawQuery)
	if err != nil {
		return failure("invalid_path")
	}
	for key, values := range params {
		if len(values) != 1 {
			return failure("invalid_path")
		}
		switch {
		case method == http.MethodPut && isHomeAIUpload(method, path.Path):
			if key == "offset" {
				continue
			}
		case method == http.MethodGet && path.Path == homeAIPath+"/assets":
			switch key {
			case "q", "tag", "date", "mediaType", "source", "suggestedTag", "limit", "offset":
				continue
			}
		case method == http.MethodGet && path.Path == homeAIPath+"/space-destination/folders":
			if key == "parent" {
				continue
			}
		}
		return failure("invalid_path")
	}
	return nil
}

func (s *service) homeAIPeer(ip netip.Addr) (engine, context.Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, p := s.engine, s.proxy
	if e == nil || p == nil || s.starting || time.Since(s.statusAt) >= statusMaxAge {
		return nil, nil, failure("network_unavailable")
	}
	for _, peer := range s.statusValue.Peers {
		if peer.IP == ip.String() && peer.Connected {
			p.mu.Lock()
			defer p.mu.Unlock()
			if !p.closed && p.engine == e {
				return e, p.ctx, nil
			}
			break
		}
	}
	return nil, nil, failure("peer_unavailable")
}

func (s *service) requestHomeAI(parent context.Context, p homeAIRequest) (homeAIResponse, error) {
	ip, err := p.validatedTarget()
	if err != nil {
		return homeAIResponse{}, err
	}
	path, err := p.route()
	if err != nil {
		return homeAIResponse{}, err
	}
	e, lifetime, err := s.homeAIPeer(ip)
	if err != nil {
		return homeAIResponse{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	defer context.AfterFunc(lifetime, cancel)()
	path.Scheme, path.Host = "http", p.Target
	req, err := http.NewRequestWithContext(ctx, p.Method, path.String(), bytes.NewReader(p.Body))
	if err != nil {
		return homeAIResponse{}, failure("invalid_params")
	}
	req.GetBody = nil
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	if p.ContentType != "" {
		req.Header.Set("Content-Type", p.ContentType)
	}
	transport := &http.Transport{
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 64 * 1024,
		DialContext: func(ctx context.Context, _, target string) (net.Conn, error) {
			if target != p.Target || lifetime.Err() != nil || !e.Allowed(ip) {
				return nil, failure("peer_unavailable")
			}
			return e.DialContext(ctx, "tcp", p.Target)
		},
	}
	defer transport.CloseIdleConnections()
	res, err := transport.RoundTrip(req)
	if err != nil {
		return homeAIResponse{}, failure("request_failed")
	}
	defer res.Body.Close()
	if res.ContentLength > maxHomeAIResponseBody {
		return homeAIResponse{}, failure("response_too_large")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxHomeAIResponseBody+1))
	if err != nil || lifetime.Err() != nil || ctx.Err() != nil {
		return homeAIResponse{}, failure("request_failed")
	}
	if len(body) > maxHomeAIResponseBody {
		return homeAIResponse{}, failure("response_too_large")
	}
	return homeAIResponse{Status: res.StatusCode, Body: body}, nil
}
