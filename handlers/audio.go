package handlers

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// ServeAudio 鉴权后提供音频文件：防路径穿越 + 扩展名白名单 + nosniff
func ServeAudio(uploadDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		reqPath := strings.TrimPrefix(c.Param("filepath"), "/")
		if reqPath == "" || strings.Contains(reqPath, "..") {
			c.Status(http.StatusNotFound)
			return
		}
		name := filepath.Base(reqPath)
		if name != reqPath {
			c.Status(http.StatusNotFound)
			return
		}
		if !allowedAudioExts[strings.ToLower(filepath.Ext(name))] {
			c.Status(http.StatusNotFound)
			return
		}
		full := filepath.Join(uploadDir, name)
		// 防路径穿越（双保险）
		abs, err := filepath.Abs(full)
		dir, _ := filepath.Abs(uploadDir)
		if err != nil || !strings.HasPrefix(abs, filepath.Clean(dir)+string(filepath.Separator)) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Header("X-Content-Type-Options", "nosniff")
		http.ServeFile(c.Writer, c.Request, full)
	}
}