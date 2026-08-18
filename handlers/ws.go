package handlers

import (
	"database/sql"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"WalkieTalkie/hub"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// 仅允许同源 WebSocket；无 Origin 的旧式客户端放行
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return u.Host == r.Host
	},
}

// WS 建立 WebSocket 连接（WebRTC 信令 + 在线状态 + 聊天）
func WS(h *hub.Hub, db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("user_id")
		username := c.GetString("username")
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		client := &hub.Client{
			ID:       userID,
			Username: username,
			Send:     make(chan []byte, 128),
		}
		ws := &hub.WSConn{Conn: conn}
		go h.WritePump(client, ws)
		h.ReadPump(client, ws)
	}
}

// ICEConfig 返回前端可用的 ICE 服务器配置
func ICEConfig(iceServers string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var servers interface{}
		// 从配置读取 JSON 数组；失败则返回默认 STUN
		if err := jsonUnmarshal([]byte(iceServers), &servers); err != nil {
			servers = []map[string]interface{}{
				{"urls": []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"}},
			}
		}
		c.JSON(http.StatusOK, gin.H{"iceServers": servers})
	}
}
