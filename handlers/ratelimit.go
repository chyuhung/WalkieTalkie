package handlers

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// rateEntry 固定窗口内的请求计数
type rateEntry struct {
	count   int
	resetAt time.Time
}

// RateLimit 简单的内存固定窗口限流（按客户端 IP），用于登录/注册等敏感接口
func RateLimit(max int, window string) gin.HandlerFunc {
	d, err := time.ParseDuration(window)
	if err != nil || d <= 0 {
		d = time.Minute
	}
	var mu sync.Mutex
	entries := make(map[string]*rateEntry)
	return func(c *gin.Context) {
		ip := c.ClientIP()
		now := time.Now()
		mu.Lock()
		e := entries[ip]
		if e == nil || now.After(e.resetAt) {
			e = &rateEntry{count: 0, resetAt: now.Add(d)}
			entries[ip] = e
		}
		e.count++
		over := e.count > max
		// 定期清理过期条目，避免内存无限增长
		if len(entries) > 1024 {
			for k, v := range entries {
				if now.After(v.resetAt) {
					delete(entries, k)
				}
			}
		}
		mu.Unlock()
		if over {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}
		c.Next()
	}
}