package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// messageRow 数据库消息行
type messageRow struct {
	ID        int64
	RoomID    int64
	UserID    int64
	Username  string
	MsgType   string
	Content   string
	AudioURL  string
	Duration  float64
	CreatedAt string
}

// SendTextMessage 发送文本聊天消息
func SendTextMessage(db *sql.DB, broadcast func(roomID int64, msg interface{})) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			RoomID  int64  `json:"room_id"`
			Content string `json:"content"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		req.Content = trimSpace(req.Content)
		content := []rune(req.Content)
		if len(content) < 1 || len(content) > 1000 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "消息长度需在 1-1000 字之间"})
			return
		}
		if !isMember(db, req.RoomID, c.GetInt64("user_id")) {
			c.JSON(http.StatusForbidden, gin.H{"error": "尚未加入该房间"})
			return
		}
		res, err := db.Exec("INSERT INTO messages(room_id, user_id, msg_type, content) VALUES(?, ?, 'text', ?)",
			req.RoomID, c.GetInt64("user_id"), req.Content)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
		id, _ := res.LastInsertId()
		msg := gin.H{
			"id":         id,
			"user_id":    c.GetInt64("user_id"),
			"username":   c.GetString("username"),
			"type":       "text",
			"content":    req.Content,
			"created_at": nowStr(),
		}
		broadcast(req.RoomID, gin.H{"type": "chat", "data": msg})
		c.JSON(http.StatusOK, msg)
	}
}

// UploadVoice 上传语音消息（音频文件 + 可选的浏览器端转写文本）
func UploadVoice(db *sql.DB, broadcast func(roomID int64, msg interface{}), maxSize int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID, err1 := strconv.ParseInt(c.PostForm("room_id"), 10, 64)
		transcript := trimSpace(c.PostForm("transcript"))
		if err1 != nil || roomID <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间 ID 无效"})
			return
		}
		if !isMember(db, roomID, c.GetInt64("user_id")) {
			c.JSON(http.StatusForbidden, gin.H{"error": "尚未加入该房间"})
			return
		}
		file, err := c.FormFile("audio")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少音频文件"})
			return
		}
		if file.Size > maxSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "音频文件过大"})
			return
		}
		if file.Size == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "音频文件为空"})
			return
		}
		url, err := saveAudio(c, file)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存音频失败: " + err.Error()})
			return
		}
		duration, _ := strconv.ParseFloat(c.PostForm("duration"), 64)
		res, err := db.Exec("INSERT INTO messages(room_id, user_id, msg_type, content, audio_url, duration) VALUES(?, ?, 'voice', ?, ?, ?)",
			roomID, c.GetInt64("user_id"), transcript, url, duration)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
		id, _ := res.LastInsertId()
		msg := gin.H{
			"id":         id,
			"user_id":    c.GetInt64("user_id"),
			"username":   c.GetString("username"),
			"type":       "voice",
			"content":    transcript,
			"audio_url":  url,
			"duration":   duration,
			"created_at": nowStr(),
		}
		broadcast(roomID, gin.H{"type": "voice", "data": msg})
		c.JSON(http.StatusOK, msg)
	}
}

// GetMessages 分页加载聊天记录
func GetMessages(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID, err := strconv.ParseInt(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间 ID 无效"})
			return
		}
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
		if limit < 1 || limit > 200 {
			limit = 50
		}
		before, _ := strconv.ParseInt(c.DefaultQuery("before", "0"), 10, 64)

		var rows *sql.Rows
		if before > 0 {
			rows, err = db.Query(`
				SELECT m.id, m.room_id, m.user_id, u.username, m.msg_type, m.content, m.audio_url, m.duration, m.created_at
				FROM messages m JOIN users u ON u.id = m.user_id
				WHERE m.room_id = ? AND m.id < ?
				ORDER BY m.id DESC LIMIT ?`, roomID, before, limit)
		} else {
			rows, err = db.Query(`
				SELECT m.id, m.room_id, m.user_id, u.username, m.msg_type, m.content, m.audio_url, m.duration, m.created_at
				FROM messages m JOIN users u ON u.id = m.user_id
				WHERE m.room_id = ?
				ORDER BY m.id DESC LIMIT ?`, roomID, limit)
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
			return
		}
		defer rows.Close()
		var list []messageRow
		for rows.Next() {
			var m messageRow
			rows.Scan(&m.ID, &m.RoomID, &m.UserID, &m.Username, &m.MsgType, &m.Content, &m.AudioURL, &m.Duration, &m.CreatedAt)
			list = append(list, m)
		}
		// 倒序反转，返回时间正序
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
		c.JSON(http.StatusOK, gin.H{
			"messages":    list,
			"has_more":    len(list) == limit,
			"now":         nowStr(),
		})
	}
}

func isMember(db *sql.DB, roomID, userID int64) bool {
	var cnt int
	db.QueryRow("SELECT COUNT(*) FROM room_members WHERE room_id = ? AND user_id = ?", roomID, userID).Scan(&cnt)
	return cnt > 0
}