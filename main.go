package main

import (
	"embed"

	"ducs-table/internal/models"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:app-dist
var assets embed.FS

func main() {
	app := NewApp()
	if err := wails.Run(&options.App{
		Title:            "Duc's Table",
		Width:            1440,
		Height:           900,
		MinWidth:         1080,
		MinHeight:        680,
		BackgroundColour: &options.RGBA{R: 8, G: 11, B: 9, A: 1},
		AssetServer:      &assetserver.Options{Assets: assets},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "com.wails.ducs-table",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				if app.ctx == nil {
					return
				}
				runtime.WindowShow(app.ctx)
				runtime.WindowUnminimise(app.ctx)
			},
		},
		ErrorFormatter: func(err error) any {
			return models.AsAppError(err)
		},
		Bind: []interface{}{app},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
			About: &mac.AboutInfo{
				Title:   "Duc's Table",
				Message: "Local data exploration powered by DuckDB.",
			},
		},
	}); err != nil {
		println("Duc's Table failed to start:", err.Error())
	}
}
