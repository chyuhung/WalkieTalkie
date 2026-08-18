package hub

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second
	maxMsgSize = 5 * 1024 * 1024 // 5MB，允许传输大 SDP
)

// WSConn 包装 websocket 连接
type WSConn struct {
	Conn *websocket.Conn
}

// HandleSignals 处理一条来自客户端的 WebSocket 信令消息
func (h *Hub) HandleSignals(c *Client, msg Message) {
	switch msg.Type {
	case "join":
		if msg.Room == 0 {
			return
		}
		// 服务端校验成员关系，防止伪造 join 混入未加入的房间
		if h.MemberCheck != nil && !h.MemberCheck(c.ID, msg.Room) {
			c.sendJSON(map[string]interface{}{"type": "error", "data": "尚未加入该房间"})
			return
		}
		c.SetRoom(msg.Room)
		h.Join(c)
	case "leave":
		h.Leave(c)
	case "speaking":
		var data struct {
			Talking bool `json:"talking"`
		}
		json.Unmarshal(msg.Data, &data)
		h.Speaking(c.GetRoom(), c.ID, data.Talking)
	case "webrtc_offer", "webrtc_answer", "webrtc_ice":
		if msg.To == 0 {
			return
		}
		roomID := c.GetRoom()
		if roomID == 0 {
			return
		}
		r := h.Room(roomID)
		if r == nil {
			return
		}
		envelope := map[string]interface{}{
			"type": msg.Type,
			"from": c.ID,
			"data": msg.Data,
		}
		r.relay(envelope, msg.To)
	case "ping":
		c.sendJSON(map[string]interface{}{"type": "pong"})
	}
}

// ReadPump 持续读取客户端消息并分发到信令处理
func (h *Hub) ReadPump(c *Client, ws *WSConn) {
	defer func() {
		h.Leave(c)
		close(c.Send)
	}()
	ws.Conn.SetReadLimit(maxMsgSize)
	ws.Conn.SetReadDeadline(time.Now().Add(pongWait))
	ws.Conn.SetPongHandler(func(string) error {
		ws.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, data, err := ws.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket 读取错误: %v", err)
			}
			break
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("消息解析失败: %v", err)
			continue
		}
		h.HandleSignals(c, msg)
	}
}

// WritePump 将发送队列中的消息写入连接，并定期发送 ping
func (h *Hub) WritePump(c *Client, ws *WSConn) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		ws.Conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.Send:
			ws.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				ws.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := ws.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			ws.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := ws.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
