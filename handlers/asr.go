package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// ASRConfig 保存第三方语音转文字服务的配置
type ASRConfig struct {
	Provider string
	APIKey   string
	APIURL   string
}

var currentASR = &ASRConfig{}

// SetupASR 设置第三方 ASR 配置
func SetupASR(cfg *ASRConfig) {
	currentASR = cfg
}

// jsonUnmarshal 便捷 JSON 解析
func jsonUnmarshal(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// ASR 预留的第三方语音转文字接口
// 前端可将录音文件 POST 到这里获取转写文本，便于在浏览器不支持 Web Speech API 时兜底。
func ASR() gin.HandlerFunc {
	return func(c *gin.Context) {
		if currentASR == nil || currentASR.APIURL == "" || currentASR.APIKey == "" {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "服务器未配置第三方 ASR 服务"})
			return
		}
		file, err := c.FormFile("audio")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少音频文件"})
			return
		}
		f, err := file.Open()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无法读取音频"})
			return
		}
		defer f.Close()
		data, _ := io.ReadAll(f)

		body := bytes.NewBuffer(data)
		req, err := http.NewRequest("POST", currentASR.APIURL, body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "请求构建失败"})
			return
		}
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Authorization", "Bearer "+currentASR.APIKey)
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "调用第三方 ASR 失败: " + err.Error()})
			return
		}
		defer resp.Body.Close()
		respBody, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			c.JSON(resp.StatusCode, gin.H{"error": "第三方 ASR 返回错误"})
			return
		}
		var result struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(respBody, &result); err != nil {
			// 兜底：若返回纯文本则直接使用
			result.Text = string(respBody)
		}
		c.JSON(http.StatusOK, gin.H{"text": result.Text})
	}
}
