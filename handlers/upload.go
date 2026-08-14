package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"mime/multipart"
	"path/filepath"
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
