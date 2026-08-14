package middleware

import (
	"database/sql"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

// ErrorHandler 统一错误处理
func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			c.JSON(http.StatusInternalServerError, gin.H{"error": c.Errors.Last().Error()})
		}
	}
}

// AuthMiddleware 校验用户登录态
func AuthMiddleware(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		session := sessions.Default(c)
		userID, ok := session.Get("user_id").(int64)
		if !ok || userID <= 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		var username string
		err := db.QueryRow("SELECT username FROM users WHERE id = ?", userID).Scan(&username)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "用户不存在"})
			return
		}
		c.Set("user_id", userID)
		c.Set("username", username)
		c.Next()
	}
}
