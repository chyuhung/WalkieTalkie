package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// nowStr 返回数据库可用的时间字符串（与 SQLite CURRENT_TIMESTAMP 一致，UTC）
func nowStr() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05")
}

// saveAudio 保存上传的音频文件，返回 URL 路径
func saveAudio(c *gin.Context, file *multipart.FileHeader) (string, error) {
	ext := filepath.Ext(file.Filename)
	if ext == "" {
		ext = ".webm"
	}
	name := time.Now().UTC().Format("20060102150405") + "_" + randName(8) + ext
	dst := filepath.Join(c.GetString("upload_dir"), name)
	if err := c.SaveUploadedFile(file, dst); err != nil {
		return "", err
	}
	return "/audio/" + name, nil
}

// randName 生成随机十六进制字符串
func randName(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)[:n*2]
}

// cleanupRoomAudio 删除房间删除后遗留的语音文件
func cleanupRoomAudio(db *sql.DB, uploadDir string, roomID int64) {
	rows, err := db.Query("SELECT audio_url FROM messages WHERE room_id = ? AND msg_type = 'voice' AND audio_url != ''", roomID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var url string
		rows.Scan(&url)
		// /audio/xxx.ext -> dir/xxx.ext
		name := strings.TrimPrefix(url, "/audio/")
		if name == url {
			continue
		}
		os.Remove(filepath.Join(uploadDir, filepath.Base(name)))
	}
}
