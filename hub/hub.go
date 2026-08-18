package hub

import (
	"encoding/json"
	"sync"
)

// Message 是客户端与服务器之间交换的通用信封
type Message struct {
	Type string          `json:"type"`
	Room int64           `json:"room,omitempty"`
	To   int64           `json:"to,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Client 表示一个已连接的 WebSocket 客户端
type Client struct {
	ID       int64
	Username string
	Send     chan []byte
	hub      *Hub

	mu   sync.Mutex // 保护 room（WS 读协程与 HTTP 处理协程并发访问）
	room int64
}

// GetRoom 返回客户端当前所在房间
func (c *Client) GetRoom() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.room
}

// SetRoom 设置客户端当前所在房间
func (c *Client) SetRoom(id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.room = id
}

func (c *Client) sendJSON(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.Send <- b:
	default:
		// 发送缓冲区满则丢弃，避免阻塞
	}
}

// Room 表示一个对讲房间
type Room struct {
	ID      int64
	Name    string
	clients map[int64]*Client
	mu      sync.RWMutex
}

func (r *Room) broadcast(msg interface{}, except *Client) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clients {
		if c == except {
			continue
		}
		select {
		case c.Send <- b:
		default:
		}
	}
}

func (r *Room) relay(msg interface{}, to int64) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if c, ok := r.clients[to]; ok {
		select {
		case c.Send <- b:
		default:
		}
	}
}

// Hub 管理所有房间与客户端
type Hub struct {
	rooms map[int64]*Room
	mu    sync.RWMutex
	// MemberCheck 校验用户是否为房间成员；nil 表示不校验
	MemberCheck func(userID, roomID int64) bool
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[int64]*Room)}
}

func (h *Hub) Room(id int64) *Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[id]
}

// RegisterRoom 注册/更新房间（含名称），不存在则创建
func (h *Hub) RegisterRoom(id int64, name string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[id]; ok {
		r.Name = name
		return r
	}
	r := &Room{ID: id, Name: name, clients: make(map[int64]*Client)}
	h.rooms[id] = r
	return r
}

// Join 将客户端加入房间并通知其他成员
func (h *Hub) Join(c *Client) {
	r := h.Room(c.GetRoom())
	if r == nil {
		return
	}
	r.mu.Lock()
	r.clients[c.ID] = c
	r.mu.Unlock()
	c.hub = h

	r.broadcast(map[string]interface{}{
		"type": "user_joined",
		"data": map[string]interface{}{"id": c.ID, "username": c.Username},
	}, c)
	h.presence(r)
}

// Leave 将客户端移出房间并广播
func (h *Hub) Leave(c *Client) {
	c.mu.Lock()
	roomID := c.room
	c.room = 0
	c.mu.Unlock()
	if roomID == 0 {
		return
	}
	r := h.Room(roomID)
	if r == nil {
		return
	}
	r.mu.Lock()
	delete(r.clients, c.ID)
	r.mu.Unlock()

	r.broadcast(map[string]interface{}{
		"type": "user_left",
		"data": map[string]interface{}{"id": c.ID, "username": c.Username},
	}, nil)
	h.presence(r)
}

// presence 向房间内所有人推送当前在线成员列表
func (h *Hub) presence(r *Room) {
	if r == nil {
		return
	}
	r.mu.RLock()
	members := make([]map[string]interface{}, 0, len(r.clients))
	for _, m := range r.clients {
		members = append(members, map[string]interface{}{"id": m.ID, "username": m.Username})
	}
	r.mu.RUnlock()
	r.broadcast(map[string]interface{}{"type": "presence", "data": members}, nil)
}

// Broadcast 向房间广播通用消息（用于聊天消息等）
func (h *Hub) Broadcast(roomID int64, msg interface{}) {
	r := h.Room(roomID)
	if r == nil {
		return
	}
	r.broadcast(msg, nil)
}

// BroadcastText 广播文本聊天消息
func (h *Hub) BroadcastText(roomID int64, msg map[string]interface{}) {
	h.Broadcast(roomID, map[string]interface{}{"type": "chat", "data": msg})
}

// BroadcastVoice 广播语音消息（含转写文本）
func (h *Hub) BroadcastVoice(roomID int64, msg map[string]interface{}) {
	h.Broadcast(roomID, map[string]interface{}{"type": "voice", "data": msg})
}

// Speaking 广播对讲状态（说话/静音）
func (h *Hub) Speaking(roomID, userID int64, talking bool) {
	h.Broadcast(roomID, map[string]interface{}{
		"type": "speaking",
		"data": map[string]interface{}{"id": userID, "talking": talking},
	})
}

// ForceLeaveRoom 强制某用户离开指定房间
func (h *Hub) ForceLeaveRoom(userID, roomID int64) {
	r := h.Room(roomID)
	if r == nil {
		return
	}
	r.mu.RLock()
	c := r.clients[userID]
	r.mu.RUnlock()
	if c != nil {
		h.Leave(c)
	}
}

// DeleteRoom 删除房间并从 hub 移除，通知所有在线成员
func (h *Hub) DeleteRoom(roomID int64) {
	var room *Room
	h.mu.Lock()
	room = h.rooms[roomID]
	delete(h.rooms, roomID)
	h.mu.Unlock()
	if room == nil {
		return
	}
	room.broadcast(map[string]interface{}{
		"type":    "room_deleted",
		"data":    map[string]interface{}{"id": roomID},
	}, nil)

	room.mu.Lock()
	clients := make([]*Client, 0, len(room.clients))
	for _, c := range room.clients {
		clients = append(clients, c)
	}
	room.clients = make(map[int64]*Client)
	room.mu.Unlock()

	for _, c := range clients {
		c.SetRoom(0)
	}
}

// Shutdown 关闭所有客户端连接
func (h *Hub) Shutdown() {
	h.mu.RLock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.RUnlock()
	for _, r := range rooms {
		r.mu.RLock()
		for _, c := range r.clients {
			select {
			case c.Send <- []byte(`{"type":"server_close"}`):
			default:
			}
		}
		r.mu.RUnlock()
	}
}
