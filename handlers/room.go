package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// CreateRoom 创建对讲房间
func CreateRoom(db *sql.DB, registerRoom func(id int64, name string) interface{}) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name string `json:"name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		req.Name = trimSpace(req.Name)
		if len(req.Name) < 1 || len(req.Name) > 30 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间名称长度需在 1-30 个字符之间"})
			return
		}
		userID := c.GetInt64("user_id")
		res, err := db.Exec("INSERT INTO rooms(name, owner_id) VALUES(?, ?)", req.Name, userID)
		if err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": "房间名称已存在"})
			return
		}
		roomID, _ := res.LastInsertId()
		db.Exec("INSERT INTO room_members(room_id, user_id) VALUES(?, ?)", roomID, userID)
		registerRoom(roomID, req.Name)
		c.JSON(http.StatusOK, gin.H{"id": roomID, "name": req.Name})
	}
}

// GetRooms 返回当前用户已加入的房间列表
func GetRooms(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("user_id")
		rows, err := db.Query(`
			SELECT r.id, r.name, r.owner_id,
			       (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count
			FROM rooms r
			JOIN room_members rm ON rm.room_id = r.id
			WHERE rm.user_id = ?
			ORDER BY r.id DESC`, userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
			return
		}
		defer rows.Close()
		var rooms []gin.H
		for rows.Next() {
			var id, ownerID, memberCount int64
			var name string
			rows.Scan(&id, &name, &ownerID, &memberCount)
			rooms = append(rooms, gin.H{"id": id, "name": name, "owner_id": ownerID, "member_count": memberCount})
		}
		c.JSON(http.StatusOK, gin.H{"rooms": rooms})
	}
}

// JoinRoom 通过房间 ID 加入（自动加入成员表）
func JoinRoom(db *sql.DB, registerRoom func(id int64, name string) interface{}) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID, err := strconv.ParseInt(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间 ID 无效"})
			return
		}
		var name string
		if err := db.QueryRow("SELECT name FROM rooms WHERE id = ?", roomID).Scan(&name); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "房间不存在"})
			return
		}
		userID := c.GetInt64("user_id")
		db.Exec("INSERT OR IGNORE INTO room_members(room_id, user_id) VALUES(?, ?)", roomID, userID)
		registerRoom(roomID, name)
		c.JSON(http.StatusOK, gin.H{"id": roomID, "name": name})
	}
}

// ListAllRooms 列出所有可加入的房间
func ListAllRooms(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(`
			SELECT r.id, r.name, r.owner_id,
			       (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count
			FROM rooms r ORDER BY r.id DESC`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
			return
		}
		defer rows.Close()
		var rooms []gin.H
		for rows.Next() {
			var id, ownerID, memberCount int64
			var name string
			rows.Scan(&id, &name, &ownerID, &memberCount)
			rooms = append(rooms, gin.H{"id": id, "name": name, "owner_id": ownerID, "member_count": memberCount})
		}
		c.JSON(http.StatusOK, gin.H{"rooms": rooms})
	}
}
