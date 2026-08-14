package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

// Register 注册新用户
func Register(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		req.Username = trimSpace(req.Username)
		if len(req.Username) < 2 || len(req.Username) > 20 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户名长度需在 2-20 个字符之间"})
			return
		}
		if len(req.Password) < 6 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "密码长度至少 6 位"})
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码加密失败"})
			return
		}
		res, err := db.Exec("INSERT INTO users(username, password) VALUES(?, ?)", req.Username, string(hash))
		if err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": "用户名已存在"})
			return
		}
		userID, _ := res.LastInsertId()
		setSession(c, userID, req.Username)
		c.JSON(http.StatusOK, gin.H{"id": userID, "username": req.Username})
	}
}

// Login 用户登录
func Login(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		var id int64
		var hash string
		err := db.QueryRow("SELECT id, password FROM users WHERE username = ?", trimSpace(req.Username)).Scan(&id, &hash)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误"})
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误"})
			return
		}
		setSession(c, id, trimSpace(req.Username))
		c.JSON(http.StatusOK, gin.H{"id": id, "username": trimSpace(req.Username)})
	}
}

// Logout 退出登录
func Logout() gin.HandlerFunc {
	return func(c *gin.Context) {
		session := sessions.Default(c)
		session.Clear()
		session.Save()
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
}

// CurrentUser 返回当前登录用户信息
func CurrentUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"id":       c.GetInt64("user_id"),
			"username": c.GetString("username"),
		})
	}
}

func setSession(c *gin.Context, userID int64, username string) {
	session := sessions.Default(c)
	session.Set("user_id", userID)
	session.Set("username", username)
	session.Save()
}
