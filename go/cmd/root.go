package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// RootCmd is the main command for the PicPurge application.
var RootCmd = &cobra.Command{
	Use:   "picpurge",
	Short: "PicPurge is an image organization tool",
	Long:  `A powerful command-line tool to organize, deduplicate, and manage your image collection.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Default action if no subcommand is given
		cmd.Help()
	},
}

// Execute runs the root command.
func Execute() {
	if err := RootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
