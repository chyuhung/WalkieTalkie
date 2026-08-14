package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	_ "modernc.org/sqlite"
	"github.com/spf13/viper"

	"WalkieTalkie/handlers"
	"WalkieTalkie/hub"
	"WalkieTalkie/middleware"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	viper.SetConfigFile("config.yaml")
	if err := viper.ReadInConfig(); err != nil {
		log.Fatalf("读取配置文件失败: %v", err)
	}
	dbPath := viper.GetString("database.path")
	uploadDir := viper.GetString("upload.dir")
	secret := viper.GetString("session.secret")

	if dir := filepath.Dir(dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("创建数据库目录失败: %v", err)
		}
	}
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Fatalf("创建音频目录失败: %v", err)
	}

	dsn := "file:" + dbPath + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatalf("无法连接到数据库: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("数据库连接测试失败: %v", err)
	}
	runMigrations(db)

	hubInstance := hub.NewHub()

	// 配置第三方 ASR（可选）
	handlers.SetupASR(&handlers.ASRConfig{
		Provider: viper.GetString("asr.provider"),
		APIKey:   viper.GetString("asr.api_key"),
		APIURL:   viper.GetString("asr.api_url"),
	})

	r := gin.Default()
	r.Use(middleware.ErrorHandler())
	r.LoadHTMLGlob("templates/*")

	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	store := cookie.NewStore([]byte(secret))
	store.Options(sessions.Options{
		MaxAge:   0,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	r.Use(sessions.Sessions("wt_session", store))

	auth := middleware.AuthMiddleware(db)

	// 页面
	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", nil)
	})
	r.GET("/login", func(c *gin.Context) {
		c.HTML(http.StatusOK, "login.html", nil)
	})
	r.GET("/register", func(c *gin.Context) {
		c.HTML(http.StatusOK, "register.html", nil)
	})

	// 认证 API
	r.POST("/api/register", handlers.Register(db))
	r.POST("/api/login", handlers.Login(db))
	r.POST("/api/logout", auth, handlers.Logout())
	r.GET("/api/me", auth, handlers.CurrentUser())

	// 静态与音频
	r.Static("/static", "./static")
	r.Static("/audio", uploadDir)

	api := r.Group("/api")
	api.Use(auth)
	// 将上传目录注入上下文（语音上传与删除清理使用）
	api.Use(func(c *gin.Context) {
		c.Set("upload_dir", uploadDir)
		c.Next()
	})
	{
		// 房间
		api.POST("/rooms", handlers.CreateRoom(db, registerRoomFunc(hubInstance)))
		api.GET("/rooms", handlers.GetRooms(db))
		api.GET("/rooms/all", handlers.ListAllRooms(db))
		api.POST("/rooms/:id/join", handlers.JoinRoom(db, registerRoomFunc(hubInstance)))
		api.POST("/rooms/:id/leave", handlers.LeaveRoom(db, hubInstance.ForceLeave))
		api.DELETE("/rooms/:id", handlers.DeleteRoom(db, uploadDir, hubInstance.DeleteRoom))
		// 消息
		api.POST("/messages", handlers.SendTextMessage(db, hubInstance.Broadcast))
		api.POST("/messages/voice", handlers.UploadVoice(db, hubInstance.Broadcast, 5*1024*1024))
		api.GET("/rooms/:id/messages", handlers.GetMessages(db))
		// ASR 预留
		api.POST("/asr", handlers.ASR())
		// 对讲配置
		api.GET("/ice-config", handlers.ICEConfig(viper.GetString("webrtc.ice_servers")))
	}

	// WebSocket 信令
	r.GET("/ws", auth, handlers.WS(hubInstance, db))

	port := viper.GetString("server.port")
	if port == "" {
		port = "8083"
	}
	log.Printf("对讲机服务已启动: http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("服务器启动失败: %v", err)
	}
}

// registerRoomFunc 将房间注册进 hub
func registerRoomFunc(h *hub.Hub) func(id int64, name string) interface{} {
	return func(id int64, name string) interface{} {
		h.RegisterRoom(id, name)
		return nil
	}
}

func runMigrations(db *sql.DB) {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS rooms (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		owner_id INTEGER NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE IF NOT EXISTS room_members (
		room_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (room_id, user_id),
		FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		msg_type TEXT NOT NULL DEFAULT 'text',
		content TEXT NOT NULL DEFAULT '',
		audio_url TEXT NOT NULL DEFAULT '',
		duration REAL NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);`
	for _, stmt := range strings.Split(schema, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt != "" {
			if _, err := db.Exec(stmt); err != nil {
				log.Printf("执行迁移失败: %v", err)
			}
		}
	}
}
